# Proxinator

[![npm version](https://img.shields.io/npm/v/proxinator.svg)](https://www.npmjs.com/package/proxinator)
[![license](https://img.shields.io/npm/l/proxinator.svg)](https://github.com/deadnetco/proxinator/blob/main/LICENSE)
[![tests](https://github.com/deadnetco/proxinator/actions/workflows/ci.yml/badge.svg)](https://github.com/deadnetco/proxinator/actions/workflows/ci.yml)

Composable Node.js proxy toolkit with zero-copy TCP forwarding. Chain forward (HTTP CONNECT), reverse (SNI), and SOCKS5 proxies in a few lines — traffic flows through the kernel, not your code.

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
- **Utilities** — SNI parser, DNS randomization + caching + bogus response filtering, load balancer, measurement streams, hostname obfuscation

## Usage

### Servers

#### Forward Proxy Server

Accept HTTP CONNECT requests and tunnel connections:

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

Connect through an upstream proxy:

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

// Extract SNI hostname
sni.parseSNI(buffer); // "example.com" or null
```

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
		connection.bind(socket, meter);
	});
});

server.http.listen(8080);
```

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

// Bogus IP filtering (enabled by default — retries when DNS returns loopback, private, etc.)
// Customize which ranges are considered bogus:
const filteredLookup = proxinator.utils.dnsLookup(null, {
	bogusRanges: ["loopback", "private"],  // only filter these ranges
	maxBogusRetries: 5                      // retry up to 5 times (default: 3)
});

// Disable bogus filtering entirely:
const unfilteredLookup = proxinator.utils.dnsLookup(null, { bogusRanges: [] });

// IPv4 only — restrict DNS resolution to A records
proxinator.client.reverse(target, { lookup, family: 4 });
proxinator.client.forward(proxy, target, { lookup, family: 4 });
proxinator.client.chain([proxyA], target, { lookup, family: 4 });

// IPv6 only
proxinator.client.reverse(target, { family: 6 });

// Via agent
const ipv4Agent = proxinator.client.agent([proxyA], { lookup, family: 4 });
```

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
- `"error"` — socket error during bind or SNI parsing

## How It Works

Proxinator is a thin routing layer. Once a connection is established and `bind()` is called, Node.js takes over entirely — `socket.pipe(socket)` delegates data transfer to libuv, which uses kernel-level buffering. Traffic flows through the OS networking stack without being copied into JavaScript heap memory.

This means:
- **No per-byte JS overhead** — data moves through native buffers, not JS strings or objects
- **No parsing** — unlike HTTP proxies that inspect/rewrite traffic, Proxinator operates at the TCP level and forwards raw bytes
- **Measurement is opt-in** — the `measure` transforms only add overhead when you explicitly chain them into `bind()`
- **JS only handles routing decisions** — auth checks, SNI parsing, and destination selection happen once per connection, then the native layer handles the sustained data transfer

The result is that sustained throughput is limited by the OS and network, not by Node.js.

## Planned Features

- Proxy checker — validate proxy liveness, latency, and anonymity
- TLS stripping — connect to upstream, extract cert parameters, generate matching cert, and bind decrypted sockets for inspection

## License

GPL-2.0
