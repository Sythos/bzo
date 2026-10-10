/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */
// The UDP channel (#8): upstream's UDP for a browser, over a WebRTC data
// channel. A WebSocket is TCP, and one lost packet holds back every message
// behind it -- the stalls `[LAG]` reports. A channel that neither retries nor
// orders loses that one message and delivers the next on time, which is what
// UDP does for a BZFlag client. It carries what bzfs sends over UDP: moves and
// shots. Everything else, and all of it for a player whose channel never
// opened, stays on the WebSocket, which also carries the signalling.
// WebTransport (server/webtransport.cjs) is tried before it.
//
// It runs on the BZFlag port (#189, docs/port-mux-plan.md) over werift, a
// WebRTC stack in JavaScript. werift's UDP transport is swapped for a view of
// the BZFlag port's socket, which hands it STUN and DTLS
// (`routeUdp`) and sends for it from whichever of the host's addresses the
// peer came in on.
//
// A STUN check names its peer by the ICE username it carries, this end's
// ufrag first; from then on that peer owns the sender's address, which is how
// DTLS from it finds its way. The candidates offered are the host's IPv4
// addresses on the BZFlag port and its public IPv4, learnt once from a STUN
// server -- the port is forwarded, so the public address takes the same port.
// IPv4 only: a phone on Verizon loses its data session within a second of
// WebRTC over its IPv6 (see `voiceIceServersIpv4`), and a server that offers
// IPv4 alone leaves no IPv6 pair to form.
//
// werift is an optional dependency; without it this is off and says why
// once.

const dgram = require('node:dgram');

// The channel both ends create, negotiated rather than announced, so neither
// waits for the other to open it.
const CHANNEL_LABEL = 'udp';
const CHANNEL_OPTIONS = { negotiated: true, id: 0, ordered: false, maxRetransmits: 0 };

// What one signalling message may carry. An offer from a browser is a few
// kilobytes; a candidate line is under two hundred bytes.
const MAX_SDP_LENGTH = 16384;
const MAX_CANDIDATE_LENGTH = 512;
// Candidates that arrive before the offer has been applied, held until it is.
const MAX_QUEUED_CANDIDATES = 32;
// A move or a shot is a little over a hundred bytes; anything far larger is
// neither.
const MAX_INCOMING_MESSAGE = 2048;

// A candidate's connection address is its fifth field. An IPv6 one cannot
// pair with an IPv4-only server, and a `.local` mDNS name is a browser hiding
// its LAN address, which this end has no way to resolve.
function candidateIsUsable(candidate) {
  const address = String(candidate).replace(/^a=/, '').split(/\s+/)[4] || '';
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(address);
}

const STUN_COOKIE = 0x2112a442;

// werift's UDP transport is the process's own, so only the server's peers
// take the shared socket: the ones whose port range is the BZFlag port and
// the next (werift refuses a range of one), which no other caller asks for.
async function createUdpChannels({
  socket, routeUdp, port, iceServers = [], isRelay = () => false, log = () => {},
  load = () => require('werift'),
  loadTransport = () => require(require.resolve('werift').replace(/lib[\\/].*$/, 'lib/common/src/transport.js')),
}) {
  let werift;
  let transportModule;
  try {
    werift = load();
    transportModule = loadTransport();
  } catch (error) {
    log(`[RTC] werift unavailable (${error.message}); off`);
    return null;
  }

  // Each peer's views of the socket, by its ufrag; each remote address, once
  // a check from it has named its peer, to that peer's view.
  const byUfrag = new Map();
  const byAddress = new Map();

  const route = (datagram, from) => {
    const key = `${from.address}|${from.port}`;
    let view = byAddress.get(key);
    if (!view && datagram[0] <= 3) {
      view = byUfrag.get(stunLocalUfrag(datagram));
      if (view) {
        byAddress.set(key, view);
        view.addresses.add(key);
      }
    }
    view?.onData?.(datagram, [from.address, from.port]);
  };
  routeUdp('stun', route);
  routeUdp('dtls', route);

  const originalInit = transportModule.UdpTransport.init.bind(transportModule.UdpTransport);
  transportModule.UdpTransport.init = async (type, options = {}) => {
    const range = options.portRange;
    if (!range || range[0] !== port || range[1] !== port + 1) return originalInit(type, options);
    const view = {
      type: 'udp',
      closed: false,
      addresses: new Set(),
      onData: () => {},
      send: async (data, addr) => { socket.send(data, addr[1], addr[0]); },
      close: async () => { view.closed = true; },
      get address() { return { address: '0.0.0.0', family: 'IPv4', port }; },
      addressFamily: 4,
      host: '0.0.0.0',
      port,
    };
    return view;
  };

  const publicAddress = await stunPublicIpv4(iceServers).catch(() => null);
  log(`[RTC] werift on UDP ${port}${publicAddress ? `, public ${publicAddress}` : ''}`);
  const sessions = new Set();

  return {
    port,

    open({ name, sendSignal, onMessage, onOpen = () => {}, onClose = () => {} }) {
      const pc = new werift.RTCPeerConnection({
        iceServers: [],
        iceUseIpv4: true,
        iceUseIpv6: false,
        iceAdditionalHostAddresses: publicAddress ? [publicAddress] : undefined,
        icePortRange: [port, port + 1],
        // A server on a public address answers the browser's checks and
        // gathers nothing. Without it werift asks a STUN server -- Google's
        // when none is given -- from the shared socket, whose answer has no
        // peer to go to, and every answer waited out its five seconds.
        iceLite: true,
      });
      const channel = pc.createDataChannel(CHANNEL_LABEL, CHANNEL_OPTIONS);
      let remoteSet = false;
      let closed = false;
      let ufrag = null;
      const queued = [];
      const fail = (error) => {
        log(`[RTC] ${name}: ${error.message}`);
        session.close();
      };

      const session = {
        kind: 'rtc',
        isOpen: () => !closed && channel.readyState === 'open',
        send(text) {
          if (!session.isOpen()) return false;
          try {
            channel.send(text);
            return true;
          } catch {
            return false;
          }
        },
        signal(message) {
          if (closed) return;
          if (typeof message.sdp === 'string') {
            if (remoteSet || message.sdpType !== 'offer' || message.sdp.length > MAX_SDP_LENGTH) return;
            remoteSet = true;
            void answer(message.sdp).catch(fail);
            return;
          }
          if (typeof message.candidate !== 'string' || message.candidate.length > MAX_CANDIDATE_LENGTH) return;
          if (!candidateIsUsable(message.candidate)) return;
          const candidate = { candidate: message.candidate, sdpMid: typeof message.mid === 'string' ? message.mid : '0' };
          if (ufrag) pc.addIceCandidate(candidate).catch(() => {});
          else if (queued.length < MAX_QUEUED_CANDIDATES) queued.push(candidate);
        },
        close() {
          if (closed) return;
          closed = true;
          sessions.delete(session);
          const view = ufrag ? byUfrag.get(ufrag) : null;
          if (view) {
            byUfrag.delete(ufrag);
            for (const key of view.addresses) if (byAddress.get(key) === view) byAddress.delete(key);
          }
          pc.close().catch(() => {});
          onClose();
        },
      };

      // The answer, after which this peer's ufrag is known and its views are
      // its connection's own.
      async function answer(sdp) {
        await pc.setRemoteDescription({ type: 'offer', sdp });
        // The browser starts the DTLS handshake and this end answers it
        // (`a=setup:passive`): as the client, werift's hello never reached
        // Firefox.
        for (const dtls of pc.dtlsTransports || []) dtls.role = 'server';
        await pc.setLocalDescription(await pc.createAnswer());
        if (closed) return;
        const connection = pc.iceTransports?.[0]?.connection;
        ufrag = connection?.localUsername || null;
        const views = (connection?.protocols || []).map((protocol) => protocol.transport).filter(Boolean);
        // Every view of this peer shares the routing; the first takes it.
        if (ufrag && views.length) byUfrag.set(ufrag, views[0]);
        for (const candidate of queued.splice(0)) await pc.addIceCandidate(candidate).catch(() => {});
        sendSignal({ sdp: pc.localDescription.sdp, sdpType: 'answer' });
      }

      channel.stateChanged.subscribe((state) => {
        if (state === 'open') {
          const pair = pc.iceTransports?.[0]?.connection?.nominated;
          const remote = pair?.remoteCandidate;
          // Through a TURN relay when the peer this end talks to is one
          // (`isRelay`): `/playerlist`'s ` turn` and the scoreboard's `t`.
          if (remote && isRelay(String(remote.host).replace(/^::ffff:/, ''))) session.kind = 'turn';
          onOpen(remote ? `${remote.host}:${remote.port}` : '');
        } else if (state === 'closed') {
          session.close();
        }
      });
      channel.onMessage.subscribe((data) => {
        if (closed) return;
        const text = typeof data === 'string' ? data : Buffer.from(data).toString('utf8');
        if (text.length <= MAX_INCOMING_MESSAGE) onMessage(text);
      });
      pc.connectionStateChange.subscribe((state) => {
        if (state === 'failed' || state === 'closed') session.close();
      });
      sessions.add(session);
      return session;
    },

    close() {
      for (const session of [...sessions]) session.close();
    },
  };
}

// USERNAME (0x0006) is "receiver:sender"; on a check to this end the
// receiver is this end's ufrag.
function stunLocalUfrag(datagram) {
  let at = 20;
  while (at + 4 <= datagram.length) {
    const type = datagram.readUInt16BE(at);
    const length = datagram.readUInt16BE(at + 2);
    if (type === 0x0006) return datagram.toString('utf8', at + 4, at + 4 + length).split(':')[0];
    at += 4 + length + ((4 - (length % 4)) % 4);
  }
  return '';
}

// This host's public IPv4, from a STUN binding to the first `stun:` server
// that answers: the address a client reaches the forwarded BZFlag port on.
async function stunPublicIpv4(urls, timeoutMs = 3000) {
  for (const url of urls) {
    const match = /^stun:([^:?]+)(?::(\d+))?/i.exec(String(url));
    if (!match) continue;
    const address = await stunQuery(match[1], Number(match[2]) || 3478, timeoutMs).catch(() => null);
    if (address) return address;
  }
  return null;
}

function stunQuery(host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    const request = Buffer.alloc(20);
    request.writeUInt16BE(0x0001, 0);
    request.writeUInt32BE(STUN_COOKIE, 4);
    require('node:crypto').randomFillSync(request, 8, 12);
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error('no STUN answer'));
    }, timeoutMs);
    socket.on('message', (reply) => {
      if (reply.length < 20 || reply.readUInt16BE(0) !== 0x0101 || !reply.subarray(8, 20).equals(request.subarray(8, 20))) return;
      let at = 20;
      while (at + 4 <= reply.length) {
        const type = reply.readUInt16BE(at);
        const length = reply.readUInt16BE(at + 2);
        // XOR-MAPPED-ADDRESS, IPv4.
        if (type === 0x0020 && reply[at + 5] === 0x01) {
          const ip = (reply.readUInt32BE(at + 8) ^ STUN_COOKIE) >>> 0;
          clearTimeout(timer);
          socket.close();
          resolve([ip >>> 24, (ip >>> 16) & 255, (ip >>> 8) & 255, ip & 255].join('.'));
          return;
        }
        at += 4 + length + ((4 - (length % 4)) % 4);
      }
    });
    socket.on('error', (error) => {
      clearTimeout(timer);
      socket.close();
      reject(error);
    });
    socket.send(request, port, host);
  });
}

module.exports = {
  createUdpChannels,
  candidateIsUsable,
  stunPublicIpv4,
  CHANNEL_LABEL,
  MAX_SDP_LENGTH,
  MAX_CANDIDATE_LENGTH,
  MAX_QUEUED_CANDIDATES,
  MAX_INCOMING_MESSAGE,
};
