/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */
// Express 4 on an HTTP/2 request (docs/port-mux-plan.md). Express gives each
// request and response its own prototype, which inherits from HTTP/1's
// `IncomingMessage` and `ServerResponse`; on HTTP/2's compatibility objects
// that hides what they keep on their own prototypes -- `headers`, `url`,
// `setHeader`, `end` and the rest -- and the HTTP/1 versions run against them
// instead. So before Express sees one, each method and accessor of HTTP/2's
// prototypes is pinned onto the object itself, where Express's prototype
// cannot shadow it. HTTP/1.1 requests on the same server pass untouched.

const http2 = require('node:http2');

// Every prototype from `proto` up to, not including, `stop`.
function chain(proto, stop) {
  const out = [];
  for (let p = proto; p && p !== stop; p = Object.getPrototypeOf(p)) out.push(p);
  return out;
}

// Symbol keys too: Node's own methods call each other through them.
function pin(target, protos) {
  const done = new Set(Reflect.ownKeys(target));
  for (const proto of protos) {
    for (const name of Reflect.ownKeys(proto)) {
      const descriptor = Object.getOwnPropertyDescriptor(proto, name);
      if (name === 'constructor' || done.has(name)) continue;
      done.add(name);
      if (typeof descriptor.value === 'function') {
        Object.defineProperty(target, name, { value: descriptor.value, configurable: true, writable: true });
      } else if (descriptor.get || descriptor.set) {
        Object.defineProperty(target, name, {
          get: descriptor.get ? () => descriptor.get.call(target) : undefined,
          set: descriptor.set ? (value) => descriptor.set.call(target, value) : undefined,
          configurable: true,
        });
      }
    }
  }
}

// The HTTP/2 classes' own prototypes, short of the stream classes Express's
// HTTP/1 prototypes share with them.
const REQUEST_PROTOS = chain(http2.Http2ServerRequest.prototype, require('node:stream').Readable.prototype);
const RESPONSE_PROTOS = chain(http2.Http2ServerResponse.prototype, require('node:stream').Stream.prototype);

// `app`, made safe to hand HTTP/2 requests to.
function bridgeHttp2(app) {
  return (req, res) => {
    if (req.httpVersionMajor === 2) {
      pin(req, REQUEST_PROTOS);
      pin(res, RESPONSE_PROTOS);
      // HTTP/2 names the host in `:authority`, not a Host header, which
      // Express's `req.hostname` and bzo's own checks read.
      if (!req.headers.host && req.headers[':authority']) req.headers.host = req.headers[':authority'];
    }
    app(req, res);
  };
}

module.exports = { bridgeHttp2 };
