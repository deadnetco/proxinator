const assert = require("assert");
const net = require("net");
const reverseClient = require("../../../src/proxy/client/reverse");

describe("Reverse Proxy Client", () => {
	let targetServer;

	afterEach((done) => {
		if (targetServer && targetServer.listening) {
			targetServer.close(done);
		} else {
			done();
		}
	});

	it("should connect directly to a target", (done) => {
		const testData = "hello from target";

		targetServer = net.createServer((socket) => {
			socket.write(testData);
		});

		targetServer.listen(0, () => {
			const port = targetServer.address().port;
			const url = new URL("tcp://127.0.0.1:" + port);

			reverseClient(url).then((socket) => {
				socket.on("data", (data) => {
					assert.strictEqual(data.toString(), testData);
					socket.destroy();
					done();
				});
			});
		});
	});

	it("should return pre-existing socket directly", (done) => {
		const testData = "passthrough socket";

		targetServer = net.createServer((socket) => {
			socket.write(testData);
		});

		targetServer.listen(0, () => {
			const port = targetServer.address().port;
			const existingSocket = net.connect({ port: port, host: "127.0.0.1" });

			existingSocket.on("connect", () => {
				const url = new URL("tcp://127.0.0.1:" + port);

				reverseClient(url, { socket: existingSocket }).then((socket) => {
					assert.strictEqual(socket, existingSocket);
					socket.on("data", (data) => {
						assert.strictEqual(data.toString(), testData);
						socket.destroy();
						done();
					});
				});
			});
		});
	});

	it("should pass family option to net.connect", (done) => {
		targetServer = net.createServer((socket) => {
			socket.end();
		});

		targetServer.listen(0, "127.0.0.1", () => {
			const port = targetServer.address().port;
			const url = new URL("tcp://127.0.0.1:" + port);

			reverseClient(url, { family: 4 }).then((socket) => {
				socket.on("connect", () => {
					assert.strictEqual(socket.remoteFamily, "IPv4");
					socket.destroy();
					done();
				});
			});
		});
	});

	it("should use specified port", (done) => {
		targetServer = net.createServer((socket) => {
			socket.end();
		});

		targetServer.listen(0, () => {
			const port = targetServer.address().port;
			const url = new URL("tcp://127.0.0.1:" + port);

			reverseClient(url).then((socket) => {
				socket.on("connect", () => {
					assert.strictEqual(socket.remotePort, port);
					socket.destroy();
					done();
				});
			});
		});
	});
});
