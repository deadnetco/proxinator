# Proxinator - Claude Code Guide

Always use `/implement-js` skill when working on this project.

## Project Overview

Proxinator is a composable Node.js proxy toolkit library supporting forward (HTTP CONNECT), reverse (SNI-based TCP), and SOCKS5 proxy modes. Features proxy chaining, http.Agent integration, and measurement streams.

## Commands

- `yarn test` — run tests with coverage (nyc + mocha)
- `yarn lint` — lint source code (eslint)
- `yarn build:types` — generate TypeScript definitions from JSDoc (output in `types/`, gitignored)
- `yarn benchmark` — localhost proxy benchmark (`dev/benchmark/`)

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
- `src/utils/tunnel/index.js` — Shared bind() data path for all servers: pipes both ways, forwards half-close with end() (allowHalfOpen on both sockets), destroys both on error (ECONNRESET/EPIPE/write-after-end not reported), optional `idleTimeout` with `onTimeout`. Servers' `bind(socket, up, down, options)` delegate here and emit "timeout" on idle close
- `src/utils/sni/index.js` — TLS ClientHello parser (isClientHello, isComplete, parseSNI). Reassembles a ClientHello split across TCP segments / TLS records; `isComplete` tells callers when to stop buffering. Reverse server `waitSNI` buffers up to 64KB waiting for a complete hello
- `src/utils/dns/index.js` — Factory returning RandomResolver with rate limiting, random server selection, and bogus IP filtering. Accepts optional server list (defaults to built-in list) and options (`bogusRanges`, `bogusIPs`, `maxBogusRetries`). Retries resolve4/resolve6/resolve(A/AAAA) when results contain IPs in bogus ranges (loopback, private, etc.) or known censorship sinkhole IPs (Great Firewall / Russian ISP block pages, `DEFAULT_BOGUS_IPS`). Exports `isBogusIP`, `hasBogusIPs`, `shouldFilterResolve`, `DEFAULT_BOGUS_RANGES`, `DEFAULT_BOGUS_IPS`
- `src/utils/dns-cache/index.js` — Factory returning cacheable-lookup instance. Accepts optional resolver, defaults to system DNS
- `src/utils/dns-lookup/index.js` — Convenience factory chaining dns + dnsCache. Accepts optional `(servers, options)` and forwards options to dns factory. Returns a lookup function ready for client options
- `src/utils/balancer/index.js` — Weighted random load balancer (push, delete, getRandomCandidate)
- `src/utils/ip/index.js` — IP address utilities (createIP, ipToHex, isIP, normalizeAddress, normalizeFamily) via ipaddr.js
- `src/utils/obfuscator/index.js` — Hostname obfuscation backends barrel export
- `src/utils/obfuscator/nipio/index.js` — nip.io backend (IPv4 only, hex-encoded): fromIP, fromHostname(hostname, lookup?), convert(host, lookup?)

### Measurement (`src/measure/`)
- `src/measure/speed/index.js` — Transform stream measuring throughput (bytes/sec) over rolling 5s window
- `src/measure/bandwidth/index.js` — Transform stream tracking total bytes transferred
- `src/measure/slowdown/index.js` — Transform stream throttling throughput to a target bytes/sec by delaying each chunk. Accepts optional `rate` (defaults to 1 MiB/s). Exposes `getRate()`, emits "slowdown" events with the applied per-chunk delay (ms). Inverse of speed/bandwidth meters; pluggable into bind() like the others
- `src/measure/chain/index.js` — Chains multiple transform factories into one, forwarding events

### Dev Tools (`dev/`)
- `dev/dns-checker.js` — Validates DNS servers and generates `data/valid-dns-servers.json`
- `dev/benchmark/index.js` — `yarn benchmark`. Compares direct vs forward/socks5/reverse on localhost: conn/s, connect & RTT latency, download/upload MiB/s. Forks `dev/benchmark/proxies` (proxinator servers) and `dev/benchmark/targets` (echo/bulk/sink servers) so each runs on its own event loop. Every tunnel starts with a real captured ClientHello so reverse can route by SNI (`<target>.bench`). Env tunables: `BENCH_MODES`, `BENCH_CONNECTIONS`, `BENCH_CONCURRENCY`, `BENCH_PINGS`, `BENCH_MB`, `BENCH_STREAMS`

## Testing

- `test/fixtures/tls/` — self-signed cert (example.com, *.example.com, localhost; valid to 2126) for real TLS tests
- `test/helpers/fragmenter` — Duplex splitting writes into small delayed TCP segments; pass to `tls.connect({ socket })` to reproduce a ClientHello split by a real network (loopback never splits it)

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
- `timeout` — tunnel closed by bind's `idleTimeout` option

Each connection object wraps the raw socket and provides:
- Address helpers (getHost, getPort, getRemoteHost, etc.)
- Protocol-specific methods (getAuth, getDestination for forward/socks5; waitSNI for reverse)
- `bind(socket, upTransform?, downTransform?, { idleTimeout }?)` for bidirectional piping (via `src/utils/tunnel`)

Servers track active connections via `_connections` Set and expose `connectionCount()`.

## Planned Features

- Proxy checker — validate proxy liveness, latency, and anonymity
- TLS stripping — MITM TLS connections by extracting upstream cert params, generating matching certs, and binding decrypted sockets
