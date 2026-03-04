const assert = require("assert");
const http = require("http");
const net = require("net");
const forwardClient = require("../../../src/proxy/client/forward");

describe("Forward Proxy Client", () => {
	let mockProxy;

	afterEach(() => {
		if (mockProxy) {
			mockProxy.closeAllConnections();
			mockProxy.close(() => {});
			mockProxy = null;
		}
	});

	it("should tunnel through an HTTP CONNECT proxy", (done) => {
		const testData = "hello through tunnel";

		mockProxy = http.createServer();

		mockProxy.on("connect", (req, clientSocket) => {
			assert.strictEqual(req.url, "example.com:443");

			clientSocket.write(
				"HTTP/1.1 200 Connection Established\r\n" +
				"\r\n"
			);

			// Delay data write so the client has time to set up the data listener
			setTimeout(() => {
				clientSocket.write(testData);
			}, 50);
		});

		mockProxy.listen(0, () => {
			const port = mockProxy.address().port;
			const proxyUrl = new URL("http://127.0.0.1:" + port);

			forwardClient(proxyUrl, { host: "example.com:443" }).then((socket) => {
				socket.on("data", (data) => {
					assert.strictEqual(data.toString(), testData);
					socket.destroy();
					done();
				});
			});
		});
	});

	it("should send proxy auth when credentials provided", (done) => {
		mockProxy = http.createServer();

		mockProxy.on("connect", (req, clientSocket) => {
			const authHeader = req.headers["proxy-authorization"];
			assert.ok(authHeader);
			assert.ok(authHeader.startsWith("Basic "));

			const decoded = Buffer.from(authHeader.split(" ")[1], "base64").toString();
			assert.strictEqual(decoded, "user:pass");

			clientSocket.write(
				"HTTP/1.1 200 Connection Established\r\n" +
				"\r\n"
			);
			clientSocket.end();
		});

		mockProxy.listen(0, () => {
			const port = mockProxy.address().port;
			const proxyUrl = new URL("http://user:pass@127.0.0.1:" + port);

			forwardClient(proxyUrl, { host: "example.com:443" }).then((socket) => {
				socket.on("close", () => {
					done();
				});
			});
		});
	});

	it("should send CONNECT over pre-existing socket", (done) => {
		const testData = "through existing socket";

		mockProxy = http.createServer();

		mockProxy.on("connect", (_req, clientSocket) => {
			clientSocket.write(
				"HTTP/1.1 200 Connection Established\r\n" +
				"\r\n"
			);

			setTimeout(() => {
				clientSocket.write(testData);
			}, 50);
		});

		mockProxy.listen(0, () => {
			const port = mockProxy.address().port;
			const proxyUrl = new URL("http://127.0.0.1:" + port);

			const existingSocket = net.connect({ port: port, host: "127.0.0.1" });

			existingSocket.on("connect", () => {
				forwardClient(proxyUrl, { host: "example.com:443" }, { socket: existingSocket }).then((socket) => {
					socket.on("data", (data) => {
						assert.strictEqual(data.toString(), testData);
						socket.destroy();
						done();
					});
				});
			});
		});
	});

	it("should reject on non-200 response", (done) => {
		mockProxy = http.createServer();

		mockProxy.on("connect", (_req, clientSocket) => {
			clientSocket.write(
				"HTTP/1.1 403 Forbidden\r\n" +
				"\r\n"
			);
			clientSocket.end();
		});

		mockProxy.listen(0, () => {
			const port = mockProxy.address().port;
			const proxyUrl = new URL("http://127.0.0.1:" + port);

			forwardClient(proxyUrl, { host: "example.com:443" }).then(() => {
				done(new Error("Should have rejected"));
			}).catch((error) => {
				assert.ok(error.message.includes("403"));
				done();
			});
		});
	});
});
