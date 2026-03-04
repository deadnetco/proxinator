const assert = require("assert");
const tls = require("tls");
const net = require("net");
const sni = require("../../src/utils/sni");

describe("SNI Parser", () => {
	/**
	 * Capture a real TLS ClientHello by starting a raw TCP server
	 * and connecting with tls.connect using the given servername.
	 * @param {string} hostname - SNI hostname
	 * @returns {Promise<Buffer>} TLS ClientHello buffer
	 */
	const captureClientHello = (hostname) => {
		return new Promise((resolve) => {
			const server = net.createServer((socket) => {
				socket.once("data", (data) => {
					resolve(data);
					socket.destroy();
					server.close();
				});
			});

			server.listen(0, () => {
				const port = server.address().port;
				const socket = tls.connect({
					port: port,
					host: "127.0.0.1",
					servername: hostname,
					rejectUnauthorized: false
				});
				socket.on("error", () => {});
			});
		});
	};

	describe("isClientHello", () => {
		it("should return true for a valid TLS ClientHello", () => {
			return captureClientHello("example.com").then((hello) => {
				assert.strictEqual(sni.isClientHello(hello), true);
			});
		});

		it("should return false for non-TLS data", () => {
			const data = Buffer.from("GET / HTTP/1.1\r\n");
			assert.strictEqual(sni.isClientHello(data), false);
		});

		it("should return false for a TLS record that is not ClientHello", () => {
			// Handshake record but ServerHello (type 2)
			const buf = Buffer.from([0x16, 0x03, 0x01, 0x00, 0x05, 0x02]);
			assert.strictEqual(sni.isClientHello(buf), false);
		});
	});

	describe("parseSNI", () => {
		it("should extract hostname from a real ClientHello", () => {
			return captureClientHello("example.com").then((hello) => {
				assert.strictEqual(sni.parseSNI(hello), "example.com");
			});
		});

		it("should extract long hostnames", () => {
			return captureClientHello("subdomain.deep.example.co.uk").then((hello) => {
				assert.strictEqual(sni.parseSNI(hello), "subdomain.deep.example.co.uk");
			});
		});

		it("should return null for invalid data", () => {
			const data = Buffer.from("not tls data");
			assert.strictEqual(sni.parseSNI(data), null);
		});

		it("should return null for empty buffer", () => {
			assert.strictEqual(sni.parseSNI(Buffer.from([])), null);
		});

		it("should skip non-SNI extensions to find SNI", () => {
			// Build a ClientHello with a dummy extension (type 0x00ff) before the SNI extension
			const hostname = "skip.example.com";
			const hostnameBytes = Buffer.from(hostname, "utf8");
			const hostnameLen = hostnameBytes.length;

			// Dummy extension (type 0x00ff, 4 bytes of data)
			const dummyExtension = Buffer.concat([
				Buffer.from([0x00, 0xff]), // Extension type: not SNI
				Buffer.from([0x00, 0x04]), // Extension data length: 4
				Buffer.from([0x01, 0x02, 0x03, 0x04]) // Dummy data
			]);

			// SNI extension
			const sniExtension = Buffer.concat([
				Buffer.from([0x00, 0x00]), // Extension type: server_name (0)
				Buffer.from([
					0x00, hostnameLen + 5,
					0x00, hostnameLen + 3,
					0x00,
					0x00, hostnameLen
				]),
				hostnameBytes
			]);

			const extensions = Buffer.concat([dummyExtension, sniExtension]);
			const extensionsLength = extensions.length;

			const clientHelloBody = Buffer.concat([
				Buffer.from([0x03, 0x03]),
				Buffer.alloc(32, 0x01),
				Buffer.from([0]),
				Buffer.from([0x00, 0x02, 0x00, 0x2f]),
				Buffer.from([0x01, 0x00]),
				Buffer.from([(extensionsLength >> 8) & 0xff, extensionsLength & 0xff]),
				extensions
			]);

			const handshakeMessage = Buffer.concat([
				Buffer.from([0x01]),
				Buffer.from([0x00, (clientHelloBody.length >> 8) & 0xff, clientHelloBody.length & 0xff]),
				clientHelloBody
			]);

			const record = Buffer.concat([
				Buffer.from([0x16, 0x03, 0x01]),
				Buffer.from([(handshakeMessage.length >> 8) & 0xff, handshakeMessage.length & 0xff]),
				handshakeMessage
			]);

			assert.strictEqual(sni.parseSNI(record), hostname);
		});

		it("should return null when SNI extension is missing", () => {
			// Build a ClientHello with only a non-SNI extension and no SNI
			const dummyExtension = Buffer.concat([
				Buffer.from([0x00, 0xff]),
				Buffer.from([0x00, 0x02]),
				Buffer.from([0x01, 0x02])
			]);

			const extensionsLength = dummyExtension.length;

			const clientHelloBody = Buffer.concat([
				Buffer.from([0x03, 0x03]),
				Buffer.alloc(32, 0x01),
				Buffer.from([0]),
				Buffer.from([0x00, 0x02, 0x00, 0x2f]),
				Buffer.from([0x01, 0x00]),
				Buffer.from([(extensionsLength >> 8) & 0xff, extensionsLength & 0xff]),
				dummyExtension
			]);

			const handshakeMessage = Buffer.concat([
				Buffer.from([0x01]),
				Buffer.from([0x00, (clientHelloBody.length >> 8) & 0xff, clientHelloBody.length & 0xff]),
				clientHelloBody
			]);

			const record = Buffer.concat([
				Buffer.from([0x16, 0x03, 0x01]),
				Buffer.from([(handshakeMessage.length >> 8) & 0xff, handshakeMessage.length & 0xff]),
				handshakeMessage
			]);

			assert.strictEqual(sni.parseSNI(record), null);
		});
	});
});
