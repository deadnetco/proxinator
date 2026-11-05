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

	/**
	 * Build a ClientHello record with an SNI extension preceded by a padding
	 * extension, so tests can produce hellos of any size.
	 * @param {string} hostname - SNI hostname
	 * @param {number} paddingSize - Padding extension data length
	 * @returns {Buffer} Single TLS record containing the ClientHello
	 */
	const buildClientHello = (hostname, paddingSize) => {
		const hostnameBytes = Buffer.from(hostname, "utf8");

		const u16 = (value) => {
			return Buffer.from([(value >> 8) & 0xff, value & 0xff]);
		};

		const padding = Buffer.concat([u16(0x0015), u16(paddingSize), Buffer.alloc(paddingSize)]);

		const serverName = Buffer.concat([
			u16(0x0000),
			u16(hostnameBytes.length + 5),
			u16(hostnameBytes.length + 3),
			Buffer.from([0x00]),
			u16(hostnameBytes.length),
			hostnameBytes
		]);

		const extensions = Buffer.concat([padding, serverName]);

		const body = Buffer.concat([
			Buffer.from([0x03, 0x03]),
			Buffer.alloc(32, 0x01),
			Buffer.from([0]),
			Buffer.from([0x00, 0x02, 0x00, 0x2f]),
			Buffer.from([0x01, 0x00]),
			u16(extensions.length),
			extensions
		]);

		const message = Buffer.concat([
			Buffer.from([0x01, (body.length >> 16) & 0xff]),
			u16(body.length),
			body
		]);

		return Buffer.concat([Buffer.from([0x16, 0x03, 0x01]), u16(message.length), message]);
	};

	/**
	 * Re-frame a single-record handshake into several TLS records
	 * @param {Buffer} record - Single TLS handshake record
	 * @param {number} fragmentSize - Max handshake bytes per record
	 * @returns {Buffer}
	 */
	const splitIntoRecords = (record, fragmentSize) => {
		const message = record.subarray(5);
		const count = Math.ceil(message.length / fragmentSize);

		return Buffer.concat(Array.from({ length: count }, (_, index) => {
			const fragment = message.subarray(index * fragmentSize, (index + 1) * fragmentSize);

			return Buffer.concat([
				Buffer.from([0x16, 0x03, 0x01, (fragment.length >> 8) & 0xff, fragment.length & 0xff]),
				fragment
			]);
		}));
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

		it("should return null for a truncated ClientHello", () => {
			return captureClientHello("example.com").then((hello) => {
				assert.strictEqual(sni.parseSNI(hello.subarray(0, hello.length - 1)), null);
			});
		});

		it("should extract hostname from a ClientHello fragmented across TLS records", () => {
			const hostname = "fragmented.example.com";
			const record = buildClientHello(hostname, 3000);

			assert.strictEqual(sni.parseSNI(splitIntoRecords(record, 700)), hostname);
		});

		it("should extract hostname from a ClientHello larger than one TCP segment", () => {
			const hostname = "pq.example.com";
			const record = buildClientHello(hostname, 2000);

			assert.ok(record.length > 1460);
			assert.strictEqual(sni.parseSNI(record), hostname);
		});
	});

	describe("isComplete", () => {
		it("should return true for a whole ClientHello", () => {
			return captureClientHello("example.com").then((hello) => {
				assert.strictEqual(sni.isComplete(hello), true);
			});
		});

		it("should return false for every proper prefix of a ClientHello", () => {
			const record = buildClientHello("prefix.example.com", 1600);

			Array.from({ length: record.length - 1 }, (_, index) => index + 1).forEach((length) => {
				assert.strictEqual(sni.isComplete(record.subarray(0, length)), false, "prefix of " + length + " bytes");
			});
		});

		it("should return false until the last TLS record arrives", () => {
			const fragmented = splitIntoRecords(buildClientHello("records.example.com", 3000), 700);

			assert.strictEqual(sni.isComplete(fragmented.subarray(0, fragmented.length - 1)), false);
			assert.strictEqual(sni.isComplete(fragmented), true);
		});

		it("should return true for malformed data so callers stop waiting", () => {
			assert.strictEqual(sni.isComplete(Buffer.from("GET / HTTP/1.1\r\n")), true);
		});
	});
});
