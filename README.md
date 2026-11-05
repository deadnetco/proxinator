<h1 align="center">
	<img src="assets/banner.svg" alt="Proxinator — programmable proxy routing for Node.js" width="100%">
</h1>

[![npm version](https://img.shields.io/npm/v/proxinator.svg)](https://www.npmjs.com/package/proxinator)
[![license](https://img.shields.io/npm/l/proxinator.svg)](https://github.com/deadnetco/proxinator/blob/main/LICENSE)
[![tests](https://github.com/deadnetco/proxinator/actions/workflows/ci.yml/badge.svg)](https://github.com/deadnetco/proxinator/actions/workflows/ci.yml)

Composable Node.js proxy toolkit for programmable routing. Chain forward (HTTP CONNECT), reverse (SNI), and SOCKS5 proxies in a few lines — your code decides where each connection goes, then Node.js takes over the data path with no per-byte JS.

## Installation

```bash
yarn add proxinator
```

## Quick Start

```javascript
const proxinator = require("proxinator");

const proxy = proxinator.server.forward();

proxy.on("connection", (connection) => {
	proxinator.client.reverse(connection.getDestination()).then((socket) => {
		connection.bind(socket);
	});
});

proxy.http.listen(8080);
```

## Features

- **Servers** — Forward (HTTP CONNECT), Reverse (SNI), SOCKS5
- **Clients** — Forward, SOCKS5, Reverse (direct), Chaining, http.Agent
- **Utilities** — SNI parser, DNS randomization + caching + bogus response filtering, load balancer, measurement + throttling streams, hostname obfuscation

## Usage

### Servers

#### Forward Proxy Server

A TCP tunnel server that uses HTTP CONNECT for setup:

CONNECT only: plain proxy requests (`GET http://...`) are refused with `405 Method Not Allowed`, so nothing is relayed unencrypted by accident. If you pass your own `http.Server` that already has a request handler, plain requests are left to that handler.

```javascript
const proxinator = require("proxinator");

const proxy = proxinator.server.forward();

proxy.on("connection", (connection) => {
	const auth = connection.getAuth();
	const destination = connection.getDestination();

	console.log("Connect to:", destination.hostname + ":" + destination.port);

	proxinator.client.reverse(destination).then((socket) => {
		connection.bind(socket);
	});
});

proxy.http.listen(8080);
```

#### Reverse Proxy Server

Accept TCP connections and route by SNI domain:

```javascript
const proxinator = require("proxinator");

const proxy = proxinator.server.reverse();

proxy.on("connection", (connection) => {
	connection.waitSNI().then((hostname) => {
		console.log("SNI hostname:", hostname);

		const target = new URL("tcp://" + hostname + ":443");

		return proxinator.client.reverse(target).then((socket) => {
			connection.bind(socket);
		});
	});
});

proxy.tcp.listen(443);
```

#### SOCKS5 Proxy Server

Accept SOCKS5 CONNECT requests and tunnel connections:

```javascript
const proxinator = require("proxinator");

const proxy = proxinator.server.socks5();

proxy.on("connection", (connection) => {
	const auth = connection.getAuth();
	const destination = connection.getDestination();

	console.log("SOCKS5 connect to:", destination.hostname + ":" + destination.port);

	proxinator.client.reverse(destination).then((socket) => {
		connection.bind(socket);
	});
});

proxy.tcp.listen(1080);
```

With protocol-level authentication — credentials are validated during the SOCKS5 handshake, before the CONNECT request. No-auth clients are also checked (with `username`/`password` undefined). Socket info is always included:

```javascript
const proxy = proxinator.server.socks5(null, {
	authenticate: (info) => {
		// info: { username, password, remoteAddress, remotePort, localAddress, localPort }
		// username/password are undefined for no-auth clients
		return info.username === "admin" && info.password === "secret";
	}
});
```

### Clients

#### Forward Proxy Client

Open a TCP tunnel through an upstream HTTP CONNECT proxy. HTTP is only the handshake: once the proxy answers `200`, you get a plain `net.Socket` to the target, the same as a direct connection, and can speak any protocol over it:

```javascript
const proxinator = require("proxinator");

const proxy = new URL("http://user:pass@proxy.example.com:8080");
const target = new URL("tcp://example.com:443");

proxinator.client.forward(proxy, target).then((socket) => {
	console.log("Tunneled connection established");
});
```

#### SOCKS5 Proxy Client

Connect through an upstream SOCKS5 proxy:

```javascript
const proxinator = require("proxinator");

const proxy = new URL("socks5://user:pass@proxy.example.com:1080");
const target = new URL("tcp://example.com:443");

proxinator.client.socks5(proxy, target).then((socket) => {
	console.log("SOCKS5 tunnel established");
});
```

#### Pre-existing Sockets

Clients can also accept a pre-existing socket for manual chaining:

```javascript
// Send CONNECT through an existing socket
proxinator.client.forward(proxy, target, { socket: existingSocket });

// Send SOCKS handshake through an existing socket
proxinator.client.socks5(proxy, target, { socket: existingSocket });

// Return an existing socket directly (passthrough)
proxinator.client.reverse(target, { socket: existingSocket });
```

### Chaining & Agent

#### Proxy Chaining

Chain connections through multiple proxies. Each proxy becomes a hop through the previous tunnel. Supports mixing HTTP, HTTPS, and SOCKS5 proxies:

```javascript
const proxinator = require("proxinator");

const proxyA = new URL("http://user:pass@proxy-a.example.com:8080");
const proxyB = new URL("socks5://proxy-b.example.com:1080");
const target = new URL("tcp://example.com:443");

// Multi-hop: client → HTTP proxy → SOCKS5 proxy → target
proxinator.client.chain([proxyA, proxyB], target).then((socket) => {
	console.log("Chained connection established");
});

// Single proxy (same as forward/socks5)
proxinator.client.chain([proxyA], target).then((socket) => {
	console.log("Single hop");
});

// No proxies (falls back to direct connection)
proxinator.client.chain([], target).then((socket) => {
	console.log("Direct connection");
});

// With custom DNS (only used for the first hop)
const lookup = proxinator.utils.dnsLookup();

proxinator.client.chain([proxyA, proxyB], target, { lookup });
```

#### http.Agent

Use proxy chains as a drop-in agent for `http.request` and `https.request`:

```javascript
const proxinator = require("proxinator");
const http = require("http");

const agent = proxinator.client.agent([
	new URL("http://proxy-a.example.com:8080"),
	new URL("socks5://proxy-b.example.com:1080")
]);

http.get("http://example.com", { agent }, (res) => {
	res.pipe(process.stdout);
});
```

#### Split IP + SNI (Agent Connect Transform)

Use the agent's `connect` option to obfuscate the CONNECT target while the real hostname is used as TLS SNI. The proxy only sees the obfuscated address, but the TLS handshake inside the tunnel uses the original hostname:

```javascript
const proxinator = require("proxinator");
const https = require("https");
const nipio = require("proxinator").utils.obfuscator.nipio;

const agent = proxinator.client.agent([
	new URL("http://proxy.example.com:8080")
], {
	connect: (host, port) => {
		return nipio.convert(host).then((obfuscated) => {
			return new URL("tcp://" + obfuscated + ":" + port);
		});
	}
});

// Proxy sees CONNECT to "c0a80101.nip.io:443"
// TLS SNI is "example.com" (set automatically by Node's https module)
https.get("https://example.com", { agent }, (res) => {
	res.pipe(process.stdout);
});
```

### Routing

#### Advanced Routing

Route specific domains directly while proxying everything else through an upstream proxy:

```javascript
const proxinator = require("proxinator");

const PROXY_URL = new URL("http://user:pass@proxy.example.com:8080");
const DIRECT_DOMAINS = ["cdninstagram.com", "static.xx.fbcdn.net"];

const server = proxinator.server.forward();

server.on("connection", (connection) => {
	const destination = connection.getDestination();
	const domain = destination.hostname;

	if(DIRECT_DOMAINS.indexOf(domain) !== -1) {
		return proxinator.client.reverse(destination).then(socket => {
			connection.bind(socket);
		});
	}

	proxinator.client.forward(PROXY_URL, destination).then(socket => {
		connection.bind(socket);
	});
});

server.http.listen(8080);
```

### Utilities

#### SNI Parser

Extract hostname from TLS ClientHello:

```javascript
const sni = require("proxinator").utils.sni;

// Check if buffer is a TLS ClientHello
sni.isClientHello(buffer); // true/false

// Check whether the whole ClientHello has arrived (it can span several TCP
// segments - modern post-quantum hellos are larger than one MSS)
sni.isComplete(buffer); // false while more data is needed

// Extract SNI hostname
sni.parseSNI(buffer); // "example.com" or null
```

`connection.waitSNI()` on the reverse server already buffers until the ClientHello is complete.

#### Load Balancer

Weighted random selection:

```javascript
const createPool = require("proxinator").utils.balancer;

const pool = createPool();

pool.push("server-a", 3); // weight 3
pool.push("server-b", 1); // weight 1

pool.getRandomCandidate(); // "server-a" ~75%, "server-b" ~25%
```

#### Measurement Streams

Chain speed and bandwidth measurement into a single transform, then plug it into `bind()` to monitor traffic:

```javascript
const proxinator = require("proxinator");

const server = proxinator.server.forward();

server.on("connection", (connection) => {
	const destination = connection.getDestination();

	// Chain multiple measurements into one transform
	const meter = proxinator.measure.chain([
		proxinator.measure.bandwidth,
		proxinator.measure.speed
	]);

	// Events from inner streams are forwarded to the chain
	meter.on("bandwidth", (total) => {
		console.log(destination.hostname, "total:", total, "bytes");
	});

	meter.on("speed", (bps) => {
		console.log(destination.hostname, "speed:", Math.round(bps), "bytes/sec");
	});

	proxinator.client.reverse(destination).then((socket) => {
		// Pass as up transform to measure server-to-client traffic
		connection.bind(socket, { up: meter });
	});
});

server.http.listen(8080);
```

#### Throttle Simulator

`measure.slowdown` is the inverse of the speed and bandwidth meters: instead of
measuring throughput it **limits** it, pacing each chunk through to a target rate
(bytes/sec) by delaying delivery. Useful for simulating slow links, testing
backpressure handling, or shaping bandwidth per connection. It's a plain
pass-through transform, so it plugs into `bind()` and composes through
`measure.chain` exactly like the meters:

```javascript
const proxinator = require("proxinator");

const server = proxinator.server.forward();

server.on("connection", (connection) => {
	const destination = connection.getDestination();

	// Throttle server-to-client traffic to 256 KiB/sec
	const throttle = proxinator.measure.slowdown(256 * 1024);

	throttle.on("slowdown", (delay) => {
		console.log(destination.hostname, "delayed chunk by", Math.round(delay), "ms");
	});

	proxinator.client.reverse(destination).then((socket) => {
		// Pass as the up transform to throttle the download direction
		connection.bind(socket, { up: throttle });
	});
});

server.http.listen(8080);
```

The factory takes an optional rate in bytes per second (defaults to 1 MiB/s) and
exposes `getRate()`. Apply it as the `up` transform to throttle downloads, or as
the `down` transform to throttle uploads. Chaining a meter and a throttle
together measures and shapes the same stream in one pass.

#### DNS Configuration

By default, clients use system DNS. You can optionally set up random DNS resolution and caching:

```javascript
const proxinator = require("proxinator");

// System DNS (default — no setup needed)
proxinator.client.reverse(target);
proxinator.client.forward(proxy, target);

// Quick setup — random DNS + cache in one call (create once, reuse across connections)
const lookup = proxinator.utils.dnsLookup();

proxinator.client.reverse(target, { lookup });
proxinator.client.forward(proxy, target, { lookup });

// Custom DNS servers
const customLookup = proxinator.utils.dnsLookup(["8.8.8.8", "1.1.1.1"]);

proxinator.client.reverse(target, { lookup: customLookup });

// Manual setup — resolver and cache separately
const resolver = proxinator.utils.dns();
const cache = proxinator.utils.dnsCache(resolver);

proxinator.client.reverse(target, { lookup: cache.lookup });

// Cache only (system DNS with caching, no random resolver)
const systemCache = proxinator.utils.dnsCache();

proxinator.client.reverse(target, { lookup: systemCache.lookup });

// Bogus IP filtering (enabled by default — retries on another random server when DNS
// returns loopback, private, etc., or a known censorship sinkhole).
// Customize which ranges / IPs are considered bogus:
const filteredLookup = proxinator.utils.dnsLookup(null, {
	bogusRanges: ["loopback", "private"],  // only filter these ranges
	bogusIPs: ["81.200.2.238"],             // exact sinkhole IPs (default: DEFAULT_BOGUS_IPS)
	maxBogusRetries: 5                      // retry up to 5 times (default: 3)
});

// Disable bogus filtering entirely:
const unfilteredLookup = proxinator.utils.dnsLookup(null, { bogusRanges: [], bogusIPs: [] });

// IPv4 only — restrict DNS resolution to A records
proxinator.client.reverse(target, { lookup, family: 4 });
proxinator.client.forward(proxy, target, { lookup, family: 4 });
proxinator.client.chain([proxyA], target, { lookup, family: 4 });

// IPv6 only
proxinator.client.reverse(target, { family: 6 });

// Via agent
const ipv4Agent = proxinator.client.agent([proxyA], { lookup, family: 4 });
```

The random resolver picks public DNS servers from all over the world, and some of them sit behind national DNS censorship. The Great Firewall of China and Russian ISPs (enforcing the national blocklist) answer blocked domains — VPN and proxy hosts among them — with sinkhole IPs: block pages or blackhole addresses that refuse or drop every connection. Once cached, such an answer breaks every dial to that host. `DEFAULT_BOGUS_IPS` (exported from `proxinator.utils.dns`) lists known sinkholes; an answer containing one is retried on other random servers, which protects lookups from DNS blocks in those countries. The bundled `data/valid-dns-servers.json` also excludes Russian and Chinese resolvers.

#### Hostname Obfuscation

Convert hostnames or IPs to nip.io format to bypass proxy provider restrictions:

```javascript
const nipio = require("proxinator").utils.obfuscator.nipio;

// From an IPv4 address (hex-encoded to avoid regex detection)
nipio.fromIP("10.0.0.1"); // "0a000001.nip.io"

// Auto-detect IP vs hostname
nipio.convert("192.168.1.1");   // Promise<"c0a80101.nip.io">
nipio.convert("example.com");   // Promise<"5db8d822.nip.io">
```

### Events

#### Connection Events

All servers (forward, reverse, SOCKS5) emit events for monitoring and logging:

```javascript
const proxinator = require("proxinator");

const server = proxinator.server.forward();

server.on("connection", (connection) => {
	console.log("New connection from:", connection.getRemoteHost());
	console.log("Active connections:", server.connectionCount());

	proxinator.client.reverse(connection.getDestination()).then((socket) => {
		connection.bind(socket);
	});
});

server.on("close", (connection) => {
	console.log("Connection closed, remaining:", server.connectionCount());
});

server.on("error", (error, connection) => {
	console.error("Error:", error.message);
});

server.http.listen(8080);
```

Available events:
- `"connection"` — new connection accepted
- `"close"` — connection socket closed
- `"error"` — socket error during bind or SNI parsing (benign teardown errors such as `ECONNRESET` are not reported)
- `"timeout"` — tunnel closed by `idleTimeout` (see below)

#### Tunnel Lifecycle

`bind(socket, { up?, down?, idleTimeout? })` behaves the same on every server (`up` transforms target-to-client data, `down` client-to-target; the older positional `bind(socket, up, down, options)` still works):

- A half-close is forwarded as a half-close: when one side finishes sending (FIN), the other direction stays open, so a target can still reply after reading the client's EOF.
- Any socket error aborts the tunnel and destroys both sides.
- Established tunnels have no timeout by default. Pass `idleTimeout` (ms) to close tunnels with no traffic in either direction, per tunnel in `bind()` or as a default for every tunnel in the server factory:

```javascript
server.on("connection", (connection) => {
	proxinator.client.reverse(connection.getDestination()).then((socket) => {
		connection.bind(socket, { idleTimeout: 5 * 60 * 1000 });
	});
});

server.on("timeout", (connection) => {
	console.log("Idle tunnel closed:", connection.getRemoteHost());
});
```

Server factories share one signature, `(server?, options?)`, where either argument can be left out:

```javascript
proxinator.server.forward({ idleTimeout: 60000 }); // options only
proxinator.server.socks5(existingTcpServer, { authenticate, idleTimeout: 60000 });
proxinator.server.reverse(); // defaults
```

The same piping is available for custom servers as `proxinator.utils.tunnel(clientSocket, socket, { up, down, idleTimeout, onError, onTimeout })`.

## How It Works

Proxinator is a thin routing layer. Once a connection is established and `bind()` is called, Node.js takes over entirely — no Proxinator code runs on the data path; `socket.pipe(socket)` hands transfer to Node's stream machinery on top of libuv. Each chunk (typically up to 64KB) is read from the kernel into a native Buffer, passed through a single `data` callback and written straight back to the kernel. Buffers live outside the JavaScript heap, so traffic is never turned into JS strings or objects, and the per-chunk cost is one callback, not per-byte work.

This means:
- **No per-byte JS overhead** — data moves through native buffers, one callback per chunk, not JS strings or objects
- **No parsing** — unlike HTTP proxies that inspect/rewrite traffic, Proxinator operates at the TCP level and forwards raw bytes
- **Measurement is opt-in** — the `measure` transforms only add overhead when you explicitly chain them into `bind()`
- **JS only handles routing decisions** — auth checks, SNI parsing, and destination selection happen once per connection, then the native layer handles the sustained data transfer

The result is that sustained throughput is limited by the OS and network, not by Node.js.

### Benchmark

`yarn benchmark` runs forward, SOCKS5 and reverse proxies against a direct connection on localhost (client, proxy and targets in separate processes) and reports connection rate, connect latency, round-trip latency and download/upload throughput. Tune with `BENCH_MODES`, `BENCH_CONNECTIONS`, `BENCH_CONCURRENCY`, `BENCH_PINGS`, `BENCH_MB`, `BENCH_STREAMS`.

## Planned Features

- Proxy checker — validate proxy liveness, latency, and anonymity
- TLS stripping — connect to upstream, extract cert parameters, generate matching cert, and bind decrypted sockets for inspection

## License

GPL-2.0
