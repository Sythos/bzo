# One port

Everything on the BZFlag port, one TCP and one UDP, so an operator's
firewall -- or `bzflag.upnp` -- has two rules to make, not four. Issues #190
(TCP) and #189 (UDP). This file holds the findings and what is left; how to
configure it is in [installation.md](installation.md), the wire in
[network.md](network.md).

## TCP: built (#190)

`server/bzflag-server.cjs` reads the first bytes of each connection on the
BZFlag port and hands it on. Every protocol here speaks first from the
client, so the opening says which it is:

| opening | goes to |
|---|---|
| `BZFLAG\r\n\r\n` | the BZFlag handler, as before |
| a TLS ClientHello (`0x16 0x03`) | the HTTPS server, when `https` is set |
| an HTTP request line (`GET`, `POST`, ...) | the web app's own `http.Server` |
| anything else | the BZFlag handler, which logs what was sent |

bzfs does the same with its non-player connections (`bzfs.cxx:6153`), which
its HTTP API serves.

The web app is Express either way: the port hands it the connection, so
routes, ETags, `Cache-Control`, Brotli sidecars and WebSocket upgrades are
the same as on a server with no `bzflag` block. Node's HTTP server reads a
socket's handle directly, past bytes put back with `unshift`, so the bytes
already read reach its parser as a `data` event; TLS reads through the stream
and takes them back with `unshift`. `scripts/test-port-mux.mjs` holds the
classification.

`https: { cert, key }` in `server.json` -- PEM files, beside it or absolute --
serves the app over TLS on the BZFlag port. A headset needs it for WebXR.
`listen` is the BZFlag port, so one TCP port carries everything; a reverse
proxy points at it.

HTTP/2 where the browser offers it: with `https`, the BZFlag port's TLS is
Node's `http2.createSecureServer` with `allowHTTP1`, so a page's many
requests -- the client's startup check of every shared asset among them --
share one connection, and HTTP/1.1 still answers anything that asks for it,
WebSocket upgrades included. Express 4 is not written for HTTP/2's request
and response objects: it swaps their prototypes for HTTP/1's, hiding theirs.
`server/http2-bridge.cjs` pins HTTP/2's methods and accessors, Symbol-keyed
ones too, onto each object first, and fills `Host` from `:authority`. Pages,
assets with Brotli and conditional 304s, JSON, the 404 page and the game in
headless Chrome all ran on `h2`. A reverse proxy in front speaks HTTP/1.1 to
bzo, so a player through one gets HTTP/2 only as far as the proxy.

## UDP: built (#189)

One UDP port carrying BZFlag, WebTransport and WebRTC, a browser taking the
best that connects:

1. **WebTransport** (HTTP/3) on the BZFlag port: datagrams for what bzfs
   sends over UDP. Every current browser has it; Safari since 26.4.
   Everything else stays on the WebSocket: Safari opens no stream to this
   server, so streams cannot replace it.
2. **WebRTC** (the UDP channel) on the same port, where WebTransport does not
   connect.
3. **WebRTC through TURN over UDP**, the voice servers' relay, for a network
   that passes UDP to the relay but not to the game. TURN over TCP or TLS is
   no better than the WebSocket, so not that.
4. **The WebSocket**, which opens first in every case and carries everything
   until one of the above does. It stays: a network with no UDP, a reverse
   proxy (none passes QUIC), and an older browser all need it.

### Telling the traffic apart

RFC 7983 and RFC 9443, by the first byte:

| first byte | traffic |
|---|---|
| 0-3 | STUN or BZFlag, by bytes 2-3 (below) |
| 20-63 | DTLS: WebRTC's data |
| 64-127, 192-255 | QUIC: HTTP/3 and WebTransport |

A BZFlag datagram starts with its length (bytes 0-1, under 1024) and its
code (bytes 2-3, two ASCII letters, 0x4141 or more). STUN starts with its
type, then its length after the 20-byte header (bytes 2-3, under 1500), then
the magic cookie `0x2112A442` (bytes 4-7). So bytes 2-3 settle it: a known
BZFlag UDP code whose length fits the datagram goes to the BZFlag handler,
and the cookie confirms STUN. QUIC must not negotiate `grease_quic_bit`
(RFC 9287), which would let its first byte fall below 64. Bytes 64-79 are
also TURN channel data, which only matters to a TURN server on this port.

STUN finds its WebRTC peer by the ICE username it carries, this end's ufrag
first, and from then on that peer owns the sender's address, which is how
DTLS from it is routed. QUIC goes to the one HTTP/3 server, which keeps its
own connections by ID.

### Owning the socket

A datagram reaches one socket, so whatever serves WebRTC and WebTransport has
to take its packets from bzo's socket and send through it:

- **werift**, WebRTC in JavaScript: its `UdpTransport.init` is swapped for a
  view of the shared socket. DTLS's AES-GCM runs in Node's `crypto`; SCTP and
  ICE are JavaScript.
- **@fails-components/webtransport** over its quiche transport: QUIC and
  HTTP/3 are native, and its server socket is a Node `dgram` socket read in
  JavaScript, so its `init` takes the shared socket in place of binding one.
- **libdatachannel** (node-datachannel) binds its own socket, and neither it
  nor libjuice takes packets from outside, so it needed a port of its own.
  bzo no longer uses it.

### Measured

`scripts/bench-udp-stack.mjs`: the server a child process, measured alone;
tanks at 30 moves a second, each move relayed to every tank, gathered once
per turn of the event loop and split to fit a packet as bzo does. One x86
core, the dev server running beside it, one run each. CPU is the server
process, 100% one core; delay is p99.

| tanks | libdatachannel, own port | werift, own sockets | werift, shared | WebTransport, shared | half each, shared |
|---|---|---|---|---|---|
| 2 | 4%, 1.5 ms | 11%, 2.8 ms | 11%, 2.6 ms | 8%, 3.0 ms | 11%, 2.9 ms |
| 8 | 15%, 1.8 ms | 38%, 5.1 ms | 36%, 5.4 ms | 39%, 5.4 ms | 32%, 6.7 ms |
| 16 | 33%, 2.6 ms | 66%, 12.2 ms | 66%, 10.0 ms | 69%, 12.5 ms | 79%, 10.9 ms |

Every stack delivered every move at every load, and the shared socket held
one bound port for all of them. Sharing costs nothing over werift's own
sockets. werift and WebTransport cost about twice libdatachannel, and add up
to ten milliseconds at sixteen tanks; WebTransport's quiche is native, so its
cost is crossing into JavaScript for each datagram through web streams.

### Ciphers

Encryption is about 2% of the server's CPU on every stack at sixteen tanks
(perf, symbols summed): libdatachannel 2.5%, werift 2.1%, WebTransport under
2.5% (quiche's header protection, plus at most the 2% of its module perf
cannot name). The cost is per packet -- the stack, the system calls, the
crossings into JavaScript -- not per byte, so ordering ciphers buys a
fraction of that 2%. Each stack already takes the cheap one where it can:

- werift has only AES-128-GCM.
- QUIC is TLS 1.3, and BoringSSL under quiche takes AES-128-GCM on a CPU
  with AES instructions and ChaCha20 on one without, as browsers ask.
- libdatachannel offered `ALL:...:@STRENGTH`, 256-bit first, and browsers
  settled on ChaCha20 with it; werift, which replaced it, settles on
  AES-128-GCM (`[RTC]` logs each browser's).

### Built

- The BZFlag port sorts its datagrams (`classifyDatagram`,
  `server/bzflag-server.cjs`, tested in `scripts/test-port-mux.mjs`): BZFlag's
  to its handler, the rest to whatever `routeUdp` names for STUN, DTLS or
  QUIC.
- WebTransport (on with `https`, `"webtransport": false` to stop it) puts
  HTTP/3 on that socket (`server/webtransport.cjs`) with the `https`
  certificate, answering
  `/wt-test` only: `public/wt-test.html` echoes datagrams at 30 a second and
  one stream. On the Let's Encrypt certificate, the page through the reverse
  proxy and WebTransport straight to 5154, over IPv6 on the LAN:

  | browser | open | datagrams back | round trip p50 / p99 |
  |---|---|---|---|
  | Chrome 154, Windows 11 | 12-20 ms | 300 of 300 | 2.0 / 3.0 ms |
  | Chrome 152, Linux (Orin) | 35 ms | 300 of 300 | 1.9 / 3.6 ms |
  | Chrome 154, Windows 11, IPv4 | - | 300 of 300 | 2.0 / 19-22 ms |
  | Chrome 152, Linux (Orin), IPv4 from a DMZ | - | 300 of 300 | 1.7 / 26.7 ms |
  | Oculus Browser 152, Quest 2 | 17 ms | 300 of 300 | 4.2 / 25.2 ms |
  | Chrome 155, Android phone, Verizon IPv6 | - | 300 of 300 | 52 / 95 ms |
  | Chrome 155, Android phone, Wi-Fi IPv4 | - | 300 of 300 | 6.4 / 35 ms |
  | Chrome 155, Android phone, Wi-Fi IPv6 | - | 300 of 300 | 7.1 / 14.7 ms |
  | Firefox 153, Linux | - | in play | `dh+` on the scoreboard |
  | Safari 26.6, iPhone, IPv6 | 24-44 ms | 300 of 300 | 4 / 9-11 ms |
  | headless Chrome 155, this host | 69 ms | 300 of 300 | 1.3 / 2.1 ms |

  The IPv4 run came from the LAN through the router's loop-back (NAT
  reflection), which adds jitter. A host on a public DMZ address could not
  reach the forwarded port over UDP until the router forwarded UDP from the
  DMZ as well: its TCP went through a proxy on the router, and its loop-back
  forward covered only the LAN's own subnets.

  A phone on the server's own LAN got Chrome's Local Network Access prompt
  ("access to your local devices"); until it was allowed, opens failed at
  once with nothing on the wire. A player on the internet should not see it.

  A Quest set down mid-run drops every session at once when it sleeps; its
  log lines arrive when it wakes. That is the headset, not loss: every Quest
  run before it was put down came back whole.

  Safari 26.6 on iOS opens a session and carries datagrams, but never opens
  a bidirectional stream to this server, and has only `createWritable` for
  datagrams, not Chrome's older `writable`. So the game's token goes in a
  datagram, not on a stream. Its `ready` was also seen never to settle after
  a close, so every wait on WebTransport has its own end. It reports a
  maximum datagram of 65535 bytes, which the path cannot carry; the 1000-byte
  split holds anyway.

  A real Chrome's largest datagram is 1024 bytes (headless said 1211), under
  the 1100 the UDP channel splits batches to, so the game's batches over
  WebTransport have to split smaller.
- Every one of the host's addresses has its own socket on the port, beside
  the wildcard one. A wildcard socket answers from whichever address the
  kernel prefers -- here an IPv6 temporary address -- not the one the peer
  sent to, and QUIC drops what comes back from an address it never
  contacted; Node cannot say which address a datagram arrived on. The kernel
  gives a datagram to the most specific socket, and the answer leaves by the
  socket it came in on. The list is refreshed each minute, as temporary
  addresses come and go.

- The game's UDP channel over WebTransport (`/udp`): `init` offers the port
  and a token; the client opens WebTransport where it can and falls back to
  the WebRTC channel; the session stands in as the player's `udpChannel`, so
  sending, batching and `/playerlist` are the WebRTC channel's. Messages are
  split to 1000 bytes for Chrome's 1024-byte datagrams. `[WT]` logs each
  player that takes it.

- WebRTC on the BZFlag port (on unless `"webrtc": false`) runs the UDP
  channel's WebRTC
  on werift over the port's socket (`server/udp-channel.cjs`), STUN and DTLS
  routed by ICE username then by address, its public IPv4 learnt once by
  STUN. libdatachannel's own port (`webrtc.listen`, 5153) and node-datachannel
  are gone; an old `listen` is set aside with a line in the log. Headless
  Chrome held to it (`?udp=rtc`) opened through the router's loop-back on
  AES-128-GCM and carried moves both ways (`r+`);
  `scripts/test-udp-channel.mjs` round-trips it on a shared socket. It is
  ICE-lite, answering checks and gathering nothing: werift otherwise asks a
  STUN server, Google's when none is named, from the shared socket, where the
  answer has no peer to go to, and every answer waited out five seconds. And
  it is the DTLS server (`a=setup:passive`): as the client, its hello never
  reached Firefox, which then stalled after ICE connected. Firefox 153, the
  Orin and Win11 held to it all open in well under a second; Firefox and
  the Orin held to the relay (`?udp=turn`) reached the port from turn4.
  `/playerlist` says `turn+` and the scoreboard `t+` for a channel whose
  peer is one of the configured TURN relays' addresses.

- TURN over UDP: `init`'s `udpChannelIceServers` are the IPv4 voice relays'
  `turn:...?transport=udp` with the player's own credential, so WebRTC falls
  back to the relay when no direct pair works. Headless Chrome held to the
  relay (`?udp=turn`) reached the BZFlag port from turn4 and carried moves
  both ways (`r+`).

### Next

1. The load on the Orin, where CPU runs out (`scripts/bench-udp-stack.mjs`).
2. Whether capture claims, on the WebSocket, overtake the last moves on UDP:
   one `CAPTURE CLAIMED ... standing on no base` so far.

The WebTransport packages are optional dependencies. quiche's native module
is a prebuilt binary from the package's GitHub releases, linux-x64 and
linux-arm64 among them, needing glibc 2.38 or later and nothing else; the
image's `npm ci --ignore-scripts` skips its download, so the Dockerfile runs
that one package's install on its own. Built and loaded in the amd64 image;
the arm64 binary checked by hand (aarch64, libc and libm only).

## HTTP/3

Not for the web app, on this stack. The quiche transport's server sends
every request that is not a WebTransport CONNECT to a 404 (its backend call
is commented out, `http3serverstream.cc`), so nothing may advertise HTTP/3 for
the BZFlag port: an `Alt-Svc: h3` there would have browsers fetch the app over
HTTP/3 and get 404s. Node 22 has no `node:quic`. HTTP/3 would take patching
the library's native code or a separate HTTP/3 front on another UDP port.

What would speed up the client's startup checks is many requests at once on
one connection, which HTTP/2 gives; see TCP above.
