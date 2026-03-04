const assert = require("assert");
const http = require("http");
const net = require("net");
const tls = require("tls");
const createForwardServer = require("../src/proxy/server/forward");
const createReverseServer = require("../src/proxy/server/reverse");
const reverseClient = require("../src/proxy/client/reverse");
const forwardClient = require("../src/proxy/client/forward");
const socks5Client = require("../src/proxy/client/socks5");
const chainClient = require("../src/proxy/client/chain");
const speedMeasure = require("../src/measure/speed");
const bandwidthMeasure = require("../src/measure/bandwidth");
const measureChain = require("../src/measure/chain");

/**
 * Handle SOCKS5 CONNECT request
 * @param {net.Socket} socket - Client socket
 * @param {Array} connections - Track connection details
 */
const handleSocks5Request = (socket, connections) => {
	socket.once("data", (request) => {
		const cmd = request[1];
		const addrType = request[3];
		let host;
		let portOffset;

		if (addrType === 0x01) {
			host = request[4] + "." + request[5] + "." + request[6] + "." + request[7];
			portOffset = 8;
		} else if (addrType === 0x03) {
			const domainLen = request[4];
			host = request.slice(5, 5 + domainLen).toString();
			portOffset = 5 + domainLen;
		}

		const port = request.readUInt16BE(portOffset);
		connections.push({ cmd, host, port });

		if (cmd === 0x01) {
			const target = net.connect({ port: port, host: host }, () => {
				const reply = Buffer.from([0x05, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
				socket.write(reply);
				target.pipe(socket);
				socket.pipe(target);
			});

			target.on("error", () => {
				const reply = Buffer.from([0x05, 0x04, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
				socket.write(reply);
				socket.end();
			});
		}
	});
};

/**
 * Create a minimal SOCKS5 server for testing
 * @param {Object} [opts] - Options
 * @param {Object} [opts.auth] - Required credentials { username, password }
 * @returns {{ server: net.Server, connections: Array }}
 */
const createSocks5Server = (opts) => {
	const options = opts || {};
	const connections = [];

	const server = net.createServer((socket) => {
		socket.on("error", () => {});

		socket.once("data", (greeting) => {
			if (options.auth) {
				socket.write(Buffer.from([0x05, 0x02]));

				socket.once("data", (authData) => {
					const ulen = authData[1];
					const username = authData.slice(2, 2 + ulen).toString();
					const plen = authData[2 + ulen];
					const password = authData.slice(3 + ulen, 3 + ulen + plen).toString();

					if (username === options.auth.username && password === options.auth.password) {
						socket.write(Buffer.from([0x01, 0x00]));
						handleSocks5Request(socket, connections);
					} else {
						socket.write(Buffer.from([0x01, 0x01]));
						setTimeout(() => {
							socket.end();
						}, 50);
					}
				});
			} else {
				socket.write(Buffer.from([0x05, 0x00]));
				handleSocks5Request(socket, connections);
			}
		});
	});

	return { server, connections };
};

describe("End-to-End", function () {
	this.timeout(10000);

	let servers = [];

	/**
	 * Create a mock HTTP CONNECT proxy that actually forwards traffic
	 * @param {Function} [cb] - Optional callback(req, clientSocket) after CONNECT response
	 * @returns {http.Server}
	 */
	const createForwardingProxy = (cb) => {
		const server = http.createServer();

		server.on("connect", (req, clientSocket) => {
			const parts = req.url.split(":");
			const targetHost = parts[0];
			const targetPort = parseInt(parts[1], 10);

			const targetSocket = net.connect({ port: targetPort, host: targetHost }, () => {
				clientSocket.write(
					"HTTP/1.1 200 Connection Established\r\n" +
					"\r\n"
				);
				targetSocket.pipe(clientSocket);
				clientSocket.pipe(targetSocket);

				if (cb) {
					cb(req, clientSocket);
				}
			});

			targetSocket.on("error", () => {
				clientSocket.write(
					"HTTP/1.1 502 Bad Gateway\r\n" +
					"\r\n"
				);
				clientSocket.end();
			});
		});

		servers.push(server);
		return server;
	};

	afterEach(() => {
		servers.forEach((s) => {
			if (s.http || s.tcp) {
				s.close();
			} else {
				if (s.closeAllConnections) {
					s.closeAllConnections();
				}
				s.close(() => {});
			}
		});
		servers = [];
	});

	it("should relay data through forward proxy to direct target", (done) => {
		const testData = "hello from target";

		const target = net.createServer((socket) => {
			setTimeout(() => {
				socket.write(testData);
			}, 50);
		});
		servers.push(target);

		const proxy = createForwardServer();
		servers.push(proxy);

		proxy.on("error", () => {});

		proxy.on("connection", (connection) => {
			const dest = connection.getDestination();
			reverseClient(dest).then((targetSocket) => {
				targetSocket.on("connect", () => {
					connection.bind(targetSocket);
				});
			});
		});

		target.listen(0, () => {
			proxy.http.listen(0, () => {
				const proxyPort = proxy.http.address().port;
				const targetPort = target.address().port;

				const req = http.request({
					host: "127.0.0.1",
					port: proxyPort,
					method: "CONNECT",
					path: "127.0.0.1:" + targetPort
				});

				req.end();

				req.on("connect", (res, socket) => {
					assert.strictEqual(res.statusCode, 200);
					socket.on("data", (data) => {
						assert.strictEqual(data.toString(), testData);
						socket.destroy();
						done();
					});
				});

				req.on("error", () => {});
			});
		});
	});

	it("should extract SNI and route through reverse proxy", (done) => {
		let sniHostname = null;

		const target = net.createServer((socket) => {
			socket.once("data", () => {
				assert.strictEqual(sniHostname, "test.example.com");
				socket.destroy();
				done();
			});
		});
		servers.push(target);

		const proxy = createReverseServer();
		servers.push(proxy);

		proxy.on("error", () => {});

		proxy.on("connection", (connection) => {
			connection.waitSNI().then((hostname) => {
				sniHostname = hostname;

				const targetUrl = new URL("tcp://127.0.0.1:" + target.address().port);
				reverseClient(targetUrl).then((targetSocket) => {
					targetSocket.on("connect", () => {
						connection.bind(targetSocket);
					});
				});
			});
		});

		target.listen(0, () => {
			proxy.tcp.listen(0, () => {
				const proxyPort = proxy.tcp.address().port;

				const tlsSocket = tls.connect({
					port: proxyPort,
					host: "127.0.0.1",
					servername: "test.example.com",
					rejectUnauthorized: false
				});

				tlsSocket.on("error", () => {});
			});
		});
	});

	it("should chain through forward proxy to upstream proxy to target", (done) => {
		const testData = "through two proxies";

		const target = net.createServer((socket) => {
			setTimeout(() => {
				socket.write(testData);
			}, 50);
		});
		servers.push(target);

		const upstream = createForwardingProxy();

		const proxy = createForwardServer();
		servers.push(proxy);

		proxy.on("error", () => {});

		proxy.on("connection", (connection) => {
			const dest = connection.getDestination();
			const upstreamUrl = new URL("http://127.0.0.1:" + upstream.address().port);

			forwardClient(upstreamUrl, dest).then((targetSocket) => {
				connection.bind(targetSocket);
			});
		});

		target.listen(0, () => {
			upstream.listen(0, () => {
				proxy.http.listen(0, () => {
					const proxyPort = proxy.http.address().port;
					const targetPort = target.address().port;

					const req = http.request({
						host: "127.0.0.1",
						port: proxyPort,
						method: "CONNECT",
						path: "127.0.0.1:" + targetPort
					});

					req.end();

					req.on("connect", (res, socket) => {
						assert.strictEqual(res.statusCode, 200);
						socket.on("data", (data) => {
							assert.strictEqual(data.toString(), testData);
							socket.destroy();
							done();
						});
					});

					req.on("error", () => {});
				});
			});
		});
	});

	it("should route through forward proxy via SOCKS5 upstream", (done) => {
		const testData = "through socks5";

		const target = net.createServer((socket) => {
			setTimeout(() => {
				socket.write(testData);
			}, 50);
		});
		servers.push(target);

		const socks = createSocks5Server();
		servers.push(socks.server);

		const proxy = createForwardServer();
		servers.push(proxy);

		proxy.on("error", () => {});

		proxy.on("connection", (connection) => {
			const dest = connection.getDestination();
			const socksUrl = new URL("socks5://127.0.0.1:" + socks.server.address().port);

			socks5Client(socksUrl, dest).then((targetSocket) => {
				connection.bind(targetSocket);
			});
		});

		target.listen(0, () => {
			socks.server.listen(0, () => {
				proxy.http.listen(0, () => {
					const proxyPort = proxy.http.address().port;
					const targetPort = target.address().port;

					const req = http.request({
						host: "127.0.0.1",
						port: proxyPort,
						method: "CONNECT",
						path: "127.0.0.1:" + targetPort
					});

					req.end();

					req.on("connect", (res, socket) => {
						assert.strictEqual(res.statusCode, 200);
						socket.on("data", (data) => {
							assert.strictEqual(data.toString(), testData);
							socket.destroy();
							done();
						});
					});

					req.on("error", () => {});
				});
			});
		});
	});

	it("should route through forward proxy via chain client with mixed protocols", (done) => {
		const testData = "mixed chain";

		const target = net.createServer((socket) => {
			setTimeout(() => {
				socket.write(testData);
			}, 50);
		});
		servers.push(target);

		const httpUpstream = createForwardingProxy();

		const socks = createSocks5Server();
		servers.push(socks.server);

		const proxy = createForwardServer();
		servers.push(proxy);

		proxy.on("error", () => {});

		proxy.on("connection", (connection) => {
			const dest = connection.getDestination();
			const chain = [
				new URL("http://127.0.0.1:" + httpUpstream.address().port),
				new URL("socks5://127.0.0.1:" + socks.server.address().port)
			];

			chainClient(chain, dest).then((targetSocket) => {
				connection.bind(targetSocket);
			});
		});

		target.listen(0, () => {
			socks.server.listen(0, () => {
				httpUpstream.listen(0, () => {
					proxy.http.listen(0, () => {
						const proxyPort = proxy.http.address().port;
						const targetPort = target.address().port;

						const req = http.request({
							host: "127.0.0.1",
							port: proxyPort,
							method: "CONNECT",
							path: "127.0.0.1:" + targetPort
						});

						req.end();

						req.on("connect", (res, socket) => {
							assert.strictEqual(res.statusCode, 200);
							socket.on("data", (data) => {
								assert.strictEqual(data.toString(), testData);
								socket.destroy();
								done();
							});
						});

						req.on("error", () => {});
					});
				});
			});
		});
	});

	it("should validate auth on forward proxy and route when valid", (done) => {
		const testData = "authenticated";

		const target = net.createServer((socket) => {
			setTimeout(() => {
				socket.write(testData);
			}, 50);
		});
		servers.push(target);

		const proxy = createForwardServer();
		servers.push(proxy);

		proxy.on("error", () => {});

		proxy.on("connection", (connection) => {
			const auth = connection.getAuth();

			if (!auth || auth.username !== "user" || auth.password !== "secret") {
				connection.error(new Error("Proxy Authentication Required"), 407);
				return;
			}

			const dest = connection.getDestination();
			reverseClient(dest).then((targetSocket) => {
				targetSocket.on("connect", () => {
					connection.bind(targetSocket);
				});
			});
		});

		target.listen(0, () => {
			proxy.http.listen(0, () => {
				const proxyPort = proxy.http.address().port;
				const targetPort = target.address().port;
				const credentials = Buffer.from("user:secret").toString("base64");

				const req = http.request({
					host: "127.0.0.1",
					port: proxyPort,
					method: "CONNECT",
					path: "127.0.0.1:" + targetPort,
					headers: {
						"Proxy-Authorization": "Basic " + credentials
					}
				});

				req.end();

				req.on("connect", (res, socket) => {
					assert.strictEqual(res.statusCode, 200);
					socket.on("data", (data) => {
						assert.strictEqual(data.toString(), testData);
						socket.destroy();
						done();
					});
				});

				req.on("error", () => {});
			});
		});
	});

	it("should reject unauthenticated client with 407", (done) => {
		const proxy = createForwardServer();
		servers.push(proxy);

		proxy.on("error", () => {});

		proxy.on("connection", (connection) => {
			const auth = connection.getAuth();

			if (!auth || auth.username !== "user" || auth.password !== "secret") {
				connection.error(new Error("Proxy Authentication Required"), 407);
				return;
			}

			connection.end();
		});

		proxy.http.listen(0, () => {
			const proxyPort = proxy.http.address().port;

			const req = http.request({
				host: "127.0.0.1",
				port: proxyPort,
				method: "CONNECT",
				path: "example.com:443"
			});

			req.end();

			req.on("connect", (res) => {
				assert.strictEqual(res.statusCode, 407);
				done();
			});

			req.on("error", () => {});
		});
	});

	it("should relay data with measurement streams", (done) => {
		const testData = "measured data";
		let speedFired = false;
		let bandwidthFired = false;

		const target = net.createServer((socket) => {
			setTimeout(() => {
				socket.write(testData);
			}, 50);
		});
		servers.push(target);

		const proxy = createForwardServer();
		servers.push(proxy);

		proxy.on("error", () => {});

		proxy.on("connection", (connection) => {
			const dest = connection.getDestination();

			reverseClient(dest).then((targetSocket) => {
				targetSocket.on("connect", () => {
					const up = measureChain([speedMeasure, bandwidthMeasure]);

					up.on("speed", () => {
						speedFired = true;
					});

					up.on("bandwidth", () => {
						bandwidthFired = true;
					});

					connection.bind(targetSocket, up);
				});
			});
		});

		target.listen(0, () => {
			proxy.http.listen(0, () => {
				const proxyPort = proxy.http.address().port;
				const targetPort = target.address().port;

				const req = http.request({
					host: "127.0.0.1",
					port: proxyPort,
					method: "CONNECT",
					path: "127.0.0.1:" + targetPort
				});

				req.end();

				req.on("connect", (res, socket) => {
					assert.strictEqual(res.statusCode, 200);
					socket.on("data", (data) => {
						assert.strictEqual(data.toString(), testData);
						assert.ok(speedFired, "speed event should have fired");
						assert.ok(bandwidthFired, "bandwidth event should have fired");
						socket.destroy();
						done();
					});
				});

				req.on("error", () => {});
			});
		});
	});

	it("should send error response when target is unreachable", (done) => {
		const proxy = createForwardServer();
		servers.push(proxy);

		proxy.on("error", () => {});

		proxy.on("connection", (connection) => {
			const dest = connection.getDestination();

			reverseClient(dest).then((targetSocket) => {
				targetSocket.on("error", (error) => {
					connection.error(error, 502);
				});
			});
		});

		proxy.http.listen(0, () => {
			const proxyPort = proxy.http.address().port;

			const req = http.request({
				host: "127.0.0.1",
				port: proxyPort,
				method: "CONNECT",
				path: "127.0.0.1:1"
			});

			req.end();

			req.on("connect", (res) => {
				assert.strictEqual(res.statusCode, 502);
				done();
			});

			req.on("error", () => {});
		});
	});

	it("should relay data bidirectionally through forward proxy", (done) => {
		const target = net.createServer((socket) => {
			socket.on("data", (data) => {
				if (data.toString() === "ping") {
					socket.write("pong");
				}
			});
		});
		servers.push(target);

		const proxy = createForwardServer();
		servers.push(proxy);

		proxy.on("error", () => {});

		proxy.on("connection", (connection) => {
			const dest = connection.getDestination();

			reverseClient(dest).then((targetSocket) => {
				targetSocket.on("connect", () => {
					connection.bind(targetSocket);
				});
			});
		});

		target.listen(0, () => {
			proxy.http.listen(0, () => {
				const proxyPort = proxy.http.address().port;
				const targetPort = target.address().port;

				const req = http.request({
					host: "127.0.0.1",
					port: proxyPort,
					method: "CONNECT",
					path: "127.0.0.1:" + targetPort
				});

				req.end();

				req.on("connect", (res, socket) => {
					assert.strictEqual(res.statusCode, 200);

					socket.on("data", (data) => {
						assert.strictEqual(data.toString(), "pong");
						socket.destroy();
						done();
					});

					setTimeout(() => {
						socket.write("ping");
					}, 50);
				});

				req.on("error", () => {});
			});
		});
	});

	it("should transfer large data through forward proxy with bandwidth measurement", (done) => {
		const dataSize = 1024 * 1024;
		const sendBuffer = Buffer.alloc(dataSize, 0x42);
		let receivedLength = 0;
		let bandwidthTotal = 0;

		const target = net.createServer((socket) => {
			socket.on("data", (chunk) => {
				receivedLength += chunk.length;
			});

			socket.on("end", () => {
				assert.strictEqual(receivedLength, dataSize);
				assert.ok(bandwidthTotal > 0, "bandwidth should have been measured");
				done();
			});
		});
		servers.push(target);

		const proxy = createForwardServer();
		servers.push(proxy);

		proxy.on("error", () => {});

		proxy.on("connection", (connection) => {
			const dest = connection.getDestination();

			reverseClient(dest).then((targetSocket) => {
				targetSocket.on("connect", () => {
					const bw = bandwidthMeasure();

					bw.on("bandwidth", (bytes) => {
						bandwidthTotal = bytes;
					});

					connection.bind(targetSocket, null, bw);
				});
			});
		});

		target.listen(0, () => {
			proxy.http.listen(0, () => {
				const proxyPort = proxy.http.address().port;
				const targetPort = target.address().port;

				const req = http.request({
					host: "127.0.0.1",
					port: proxyPort,
					method: "CONNECT",
					path: "127.0.0.1:" + targetPort
				});

				req.end();

				req.on("connect", (res, socket) => {
					assert.strictEqual(res.statusCode, 200);
					socket.write(sendBuffer);
					socket.end();
				});

				req.on("error", () => {});
			});
		});
	});
});
