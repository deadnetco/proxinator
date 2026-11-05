const assert = require("assert");
const fs = require("fs");
const net = require("net");
const path = require("path");
const tls = require("tls");
const createReverseServer = require("../../../src/proxy/server/reverse");
const reverseClient = require("../../../src/proxy/client/reverse");
const fragmenter = require("../../helpers/fragmenter");

const FIXTURES = path.join(__dirname, "..", "..", "fixtures", "tls");
const KEY = fs.readFileSync(path.join(FIXTURES, "key.pem"));
const CERT = fs.readFileSync(path.join(FIXTURES, "cert.pem"));

/** @type {number} Delay between client segments in ms */
const SEGMENT_DELAY = 2;

/**
 * Real TLS sessions through the reverse proxy, with the client's bytes split
 * into small TCP segments the way a real network splits a large ClientHello.
 */
describe("Reverse Proxy Server - real TLS", function () {
	this.timeout(10000);

	let target;
	let proxy;
	let sniChunks;
	let sniHostname;

	beforeEach((done) => {
		sniChunks = 0;
		sniHostname = undefined;

		// TLS server answers with the SNI it saw plus the first message received
		target = tls.createServer({ key: KEY, cert: CERT }, (socket) => {
			socket.once("data", (data) => {
				socket.end(socket.servername + ":" + data);
			});
		});

		proxy = createReverseServer();
		proxy.on("error", () => {});

		proxy.on("connection", (connection) => {
			connection.socket.on("data", () => {
				if (sniHostname === undefined) {
					sniChunks++;
				}
			});

			connection.waitSNI().then((hostname) => {
				sniHostname = hostname;

				return reverseClient(new URL("tcp://127.0.0.1:" + target.address().port));
			}).then((targetSocket) => {
				connection.bind(targetSocket);
			}).catch(() => {
				connection.socket.destroy();
			});
		});

		target.listen(0, "127.0.0.1", () => {
			proxy.tcp.listen(0, "127.0.0.1", done);
		});
	});

	afterEach(() => {
		return proxy.close().then(() => {
			target.close();
		});
	});

	/**
	 * Open a verified TLS session through the proxy over a fragmenting socket
	 * @param {string} servername - SNI hostname
	 * @param {number} segmentSize - Max bytes per TCP segment
	 * @returns {Promise<{response: string, hello: number}>}
	 */
	const request = (servername, segmentSize) => {
		return new Promise((resolve, reject) => {
			const raw = net.connect({ port: proxy.tcp.address().port, host: "127.0.0.1" }, () => {
				const tlsSocket = tls.connect({
					socket: fragmenter(raw, segmentSize, SEGMENT_DELAY),
					servername: servername,
					ca: CERT
				});

				let response = "";

				tlsSocket.on("secureConnect", () => {
					tlsSocket.write("ping");
				});

				tlsSocket.on("data", (data) => {
					response += data;
				});

				tlsSocket.on("end", () => {
					resolve(response);
				});

				tlsSocket.on("error", reject);
			});

			raw.on("error", reject);
		});
	};

	[1460, 512, 100].forEach((segmentSize) => {
		it("should complete a verified TLS session with ClientHello split into " + segmentSize + "-byte segments", () => {
			return request("split.example.com", segmentSize).then((response) => {
				assert.strictEqual(sniHostname, "split.example.com");
				assert.strictEqual(response, "split.example.com:ping");
				assert.ok(sniChunks > 1, "ClientHello reached the proxy in " + sniChunks + " segment(s)");
			});
		});
	});

	it("should complete a verified TLS session with an unsplit ClientHello", () => {
		return request("whole.example.com", 65536).then((response) => {
			assert.strictEqual(sniHostname, "whole.example.com");
			assert.strictEqual(response, "whole.example.com:ping");
		});
	});

	it("should fail certificate verification for a name the certificate does not cover", () => {
		return request("other.test", 1460).then(() => {
			throw new Error("TLS session unexpectedly succeeded");
		}, (error) => {
			assert.strictEqual(sniHostname, "other.test");
			assert.strictEqual(error.code, "ERR_TLS_CERT_ALTNAME_INVALID");
		});
	});
});
