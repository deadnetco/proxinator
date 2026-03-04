# Proxinator - Claude Code Guide

Always use `/implement-js` skill when working on this project.

## Project Overview

Proxinator is a composable Node.js proxy toolkit library supporting forward (HTTP CONNECT), reverse (SNI-based TCP), and SOCKS5 proxy modes. Features proxy chaining, http.Agent integration, and measurement streams.

## Commands

- `yarn test` — run tests with coverage (nyc + mocha)
- `yarn lint` — lint source code (eslint)
- `yarn build:types` — generate TypeScript definitions from JSDoc (output in `types/`, gitignored)

## Module Map

### Proxy Components (`src/proxy/`)
- `src/proxy/server/forward/index.js` — HTTP CONNECT proxy server. Emits "connection", "close", "error" events. Connection objects provide auth parsing, destination info, bind/error/end methods. Tracks active connections via `connectionCount()`
- `src/proxy/server/reverse/index.js` — TCP reverse proxy server with SNI extraction. Emits "connection", "close", "error" events. Connection objects provide waitSNI, bind/error/end. Tracks active connections via `connectionCount()`
- `src/proxy/server/socks5/index.js` — SOCKS5 proxy server. Emits "connection", "close", "error" events. Connection objects provide getAuth, getDestination, bind/error/end. Supports no-auth and username/password auth. Optional `authenticate` option for protocol-level credential validation. Tracks active connections via `connectionCount()`
- `src/proxy/client/forward/index.js` — Connects through upstream HTTP CONNECT proxy. Accepts optional `{ lookup, socket, family }`. When `socket` provided, sends CONNECT over existing connection. Returns Promise<net.Socket>
- `src/proxy/client/reverse/index.js` — Direct TCP connection. Accepts optional `{ lookup, socket, family }`. When `socket` provided, returns it directly (passthrough). Returns Promise<net.Socket>
- `src/proxy/client/socks5/index.js` — Connects through upstream SOCKS5 proxy via `socks` package. Accepts optional `{ lookup, socket }`. When `socket` provided, sends SOCKS handshake over existing connection. Supports username/password auth from URL. Returns Promise<net.Socket>
- `src/proxy/client/chain/index.js` — Chains array of proxy URLs into a single tunnel. Protocol from URL determines client per hop (http/https → forward, socks5 → socks5). Empty array falls back to reverse (direct). Accepts optional `{ lookup, family }` for first hop only
- `src/proxy/client/agent/index.js` — Creates an http.Agent that tunnels connections through a proxy chain. Drop-in for http.request/https.request options.agent. Accepts proxy array and optional `{ lookup, family, connect }`. The `connect` option transforms the tunnel target URL for split IP+SNI support

### Utilities (`src/utils/`)
- `src/utils/sni/index.js` — TLS ClientHello parser (isClientHello, parseSNI)
- `src/utils/dns/index.js` — Factory returning RandomResolver with rate limiting and random server selection. Accepts optional server list, defaults to built-in list
- `src/utils/dns-cache/index.js` — Factory returning cacheable-lookup instance. Accepts optional resolver, defaults to system DNS
- `src/utils/dns-lookup/index.js` — Convenience factory chaining dns + dnsCache. Returns a lookup function ready for client options
- `src/utils/balancer/index.js` — Weighted random load balancer (push, delete, getRandomCandidate)
- `src/utils/ip/index.js` — IP address utilities (createIP, ipToHex, isIP, normalizeAddress, normalizeFamily) via ipaddr.js
- `src/utils/obfuscator/index.js` — Hostname obfuscation backends barrel export
- `src/utils/obfuscator/nipio/index.js` — nip.io backend (IPv4 only, hex-encoded): fromIP, fromHostname(hostname, lookup?), convert(host, lookup?)

### Measurement (`src/measure/`)
- `src/measure/speed/index.js` — Transform stream measuring throughput (bytes/sec) over rolling 5s window
- `src/measure/bandwidth/index.js` — Transform stream tracking total bytes transferred
- `src/measure/chain/index.js` — Chains multiple transform factories into one, forwarding events

### Dev Tools (`dev/`)
- `dev/dns-checker.js` — Validates DNS servers and generates `data/valid-dns-servers.json`

## Key Patterns

- **Factory functions** returning object literals with methods (not classes, except RandomResolver which extends dns.promises.Resolver)
- **Promise-based** async — chain with `.then()`, no async/await
- **EventEmitter** for connection handling on servers
- **Connection wrapper objects** providing high-level API (getAuth, getDestination, bind, waitSNI, etc.)
- **Rate limiting** via queue-promised wrapper
- **DNS is opt-in** — clients use system DNS by default, custom resolver/cache via options.lookup
- **Transform streams** for measurement (speed, bandwidth) pluggable into bind()

## Architecture

```
Server (accepts connections) + Client (connects to target) = Proxy
Forward: HTTP CONNECT protocol
Reverse: Raw TCP with SNI domain extraction
SOCKS5: SOCKS5 binary protocol
```

Servers emit events:
- `connection` — new connection accepted (connection wrapper object)
- `close` — connection socket closed
- `error` — socket error during bind or SNI parsing (replaces console.error)

Each connection object wraps the raw socket and provides:
- Address helpers (getHost, getPort, getRemoteHost, etc.)
- Protocol-specific methods (getAuth, getDestination for forward/socks5; waitSNI for reverse)
- `bind(socket, upTransform?, downTransform?)` for bidirectional piping

Servers track active connections via `_connections` Set and expose `connectionCount()`.

## Planned Features

- Proxy checker — validate proxy liveness, latency, and anonymity
- TLS stripping — MITM TLS connections by extracting upstream cert params, generating matching certs, and binding decrypted sockets
