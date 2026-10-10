/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */
// HTTP/3 and WebTransport on the BZFlag port's UDP socket (#189,
// docs/port-mux-plan.md). The QUIC stack is @fails-components/webtransport
// over its quiche transport, whose server socket is a Node `dgram` socket
// read in JavaScript: its `init` here takes the BZFlag port's socket instead
// of binding one, and the port hands it every QUIC datagram (`routeUdp`).
//
// `/udp` is a player's UDP channel (`claim`): a datagram carries the token
// the WebSocket's `init` handed out, answered `ok` once the player has the
// session, and from then on datagrams carry what bzfs sends over UDP, both
// ways. `/wt-test` is
// public/wt-test.html's echo: each datagram straight back, and each
// bidirectional stream's bytes back on it.
//
// Both packages are optional; without them this is off and says why once.

const crypto = require('node:crypto');

async function createWebTransport({ socket, routeQuic, cert, key, claim, log = () => {} }) {
  let quiche;
  let webtransport;
  try {
    quiche = await import('@fails-components/webtransport-transport-http3-quiche');
    webtransport = await import('@fails-components/webtransport');
  } catch (error) {
    log(`[WT] unavailable (${error.message}); off`);
    return null;
  }

  quiche.Http3WebTransportServerSocket.prototype.init = function init() {
    const { address, family } = socket.address();
    this.address = { address, family: family === 'IPv6' ? 6 : 4 };
    this.socketInt = socket;
    routeQuic((msg, rinfo) => {
      const haschlos = this.cobj.recvPaket({ msg, rinfo, selfaddress: socket.address() });
      if (!this.chlosSched && haschlos) {
        setImmediate(this.doProcessBufferedChlos);
        this.chlosSched = true;
      }
    });
    setImmediate(() => {
      this.jsobj.onServerListening({ port: socket.address().port, host: socket.address().address });
      this.cobj.onCanWrite();
    });
  };
  // The port's socket outlives this server; stopping only stops QUIC.
  quiche.Http3WebTransportServerSocket.prototype.stopServer = function stopServer() {
    this.cobj.destroy();
    this.closed = true;
  };

  const server = new webtransport.Http3Server({
    port: socket.address().port,
    host: socket.address().address,
    secret: crypto.randomBytes(32).toString('hex'),
    cert,
    privKey: key,
  });
  const echoes = server.sessionStream('/wt-test');
  const games = server.sessionStream('/udp');
  server.startServer();
  await server.ready;
  log(`[WT] HTTP/3 on UDP ${socket.address().port}`);
  void serveEcho(echoes, log);
  void serveSessions(games, (session) => gameSession(session, claim));

  return {
    close() {
      server.stopServer();
    },
  };
}

async function serveEcho(sessions, log) {
  await serveSessions(sessions, (session) => echoSession(session, log));
}

// Each item a stream brings, to `handle`, as it comes: the stream drives it,
// and its end or error ends it, so nothing here loops on a read.
function each(stream, handle) {
  return stream.pipeTo(new globalThis.WritableStream({ write: (item) => { handle(item); } }));
}

async function serveSessions(sessions, serve) {
  await each(sessions, (session) => { void serve(session); }).catch(() => {});
}

// How long a session has to name its player.
const CLAIM_TIMEOUT_MS = 10000;

// `claim(token)` answers `{ attach(channel), onMessage(text), onClose() }`
// for a player waiting on this session, or null. The channel is the shape
// server/udp-channel.cjs's sessions have: `isOpen`, `send`, `close`. The
// token comes in a datagram, `token:` and the token, which the client repeats
// until it hears `ok`: Safari opens no stream to this server, so the claim
// cannot ride one. Moves and shots are JSON, so never start that way.
async function gameSession(session, claim) {
  const timer = setTimeout(() => {
    try { session.close(); } catch { /* already closed */ }
  }, CLAIM_TIMEOUT_MS);
  let owner = null;
  let channel = null;
  let open = false;
  try {
    await session.ready;
    const writer = session.datagrams.createWritable().getWriter();
    await each(session.datagrams.readable, (value) => {
      const text = Buffer.from(value).toString('utf8');
      if (!text.startsWith('token:')) {
        if (open) owner.onMessage(text);
        return;
      }
      if (!channel) {
        owner = claim?.(text.slice(6)) ?? null;
        if (!owner) {
          session.close();
          return;
        }
        clearTimeout(timer);
        open = true;
        channel = {
          kind: 'h3',
          isOpen: () => open,
          send(message) {
            if (!open) return false;
            writer.write(Buffer.from(message)).catch(() => {});
            return true;
          },
          close() {
            if (!open) return;
            open = false;
            try { session.close(); } catch { /* already closed */ }
            owner.onClose();
          },
        };
        owner.attach(channel);
        session.closed.catch(() => {}).finally(() => channel.close());
      }
      writer.write(Buffer.from('ok')).catch(() => {});
    });
  } catch {
    // The session went before or while it was claimed.
  } finally {
    clearTimeout(timer);
    channel?.close();
  }
}

async function echoSession(session, log) {
  let datagrams = 0;
  try {
    await session.ready;
    log('[WT] /wt-test open');
    const writer = session.datagrams.createWritable().getWriter();
    void each(session.incomingBidirectionalStreams, (stream) => {
      void stream.readable.pipeTo(stream.writable).catch(() => {});
    }).catch(() => {});
    await each(session.datagrams.readable, (value) => {
      datagrams += 1;
      writer.write(value).catch(() => {});
    });
  } catch {
    // The session went; the count below says how far it got.
  }
  log(`[WT] /wt-test closed after ${datagrams} datagrams`);
}

module.exports = { createWebTransport };
