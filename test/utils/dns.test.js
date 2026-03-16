const assert = require("assert");
const dgram = require("dgram");
const createResolver = require("../../src/utils/dns");
const isBogusIP = createResolver.isBogusIP;
const hasBogusIPs = createResolver.hasBogusIPs;
const shouldFilterResolve = createResolver.shouldFilterResolve;
const DEFAULT_BOGUS_RANGES = createResolver.DEFAULT_BOGUS_RANGES;

/**
 * Build a minimal DNS response buffer for an A record query.
 * @param {Buffer} query - The original DNS query packet
 * @param {string} ip - IPv4 address to return
 * @returns {Buffer} DNS response buffer
 */
function buildDnsResponse(query, ip) {
	const id = query.slice(0, 2);
	const questionSection = query.slice(12);

	// Find end of question section (after QNAME + QTYPE + QCLASS)
	let offset = 0;
	while (questionSection[offset] !== 0) {
		offset += questionSection[offset] + 1;
	}
	offset += 5; // null byte + QTYPE (2) + QCLASS (2)

	const question = questionSection.slice(0, offset);
	const parts = ip.split(".").map((p) => parseInt(p, 10));

	// Header: ID, flags (response+noerror), 1 question, 1 answer, 0 auth, 0 additional
	const header = Buffer.from([
		id[0], id[1],
		0x81, 0x80,
		0x00, 0x01,
		0x00, 0x01,
		0x00, 0x00,
		0x00, 0x00
	]);

	// Answer: pointer to name in question (0xC00C), type A, class IN, TTL 60, rdlength 4, IP
	const answer = Buffer.from([
		0xC0, 0x0C,
		0x00, 0x01,
		0x00, 0x01,
		0x00, 0x00, 0x00, 0x3C,
		0x00, 0x04,
		parts[0], parts[1], parts[2], parts[3]
	]);

	return Buffer.concat([header, question, answer]);
}

/**
 * Create a mock UDP DNS server that returns controlled IP responses.
 * @param {string[]} responses - Array of IPv4 addresses to return in order (cycles last one)
 * @param {Function} callback - Called with (server, port) when ready
 * @returns {void}
 */
function createMockDnsServer(responses, callback) {
	const server = dgram.createSocket("udp4");
	let queryCount = 0;

	server.on("message", (msg, rinfo) => {
		const ip = responses[Math.min(queryCount, responses.length - 1)];
		queryCount++;

		const response = buildDnsResponse(msg, ip);
		server.send(response, rinfo.port, rinfo.address);
	});

	server.bind(0, "127.0.0.1", () => {
		const port = server.address().port;
		callback(server, port);
	});

	server.getQueryCount = () => queryCount;

	return server;
}

describe("DNS", () => {
	describe("isBogusIP", () => {
		it("should detect 0.0.0.0 as bogus (unspecified)", () => {
			assert.strictEqual(isBogusIP("0.0.0.0", DEFAULT_BOGUS_RANGES), true);
		});

		it("should detect 127.0.0.1 as bogus (loopback)", () => {
			assert.strictEqual(isBogusIP("127.0.0.1", DEFAULT_BOGUS_RANGES), true);
		});

		it("should detect 192.168.1.1 as bogus (private)", () => {
			assert.strictEqual(isBogusIP("192.168.1.1", DEFAULT_BOGUS_RANGES), true);
		});

		it("should detect 10.0.0.1 as bogus (private)", () => {
			assert.strictEqual(isBogusIP("10.0.0.1", DEFAULT_BOGUS_RANGES), true);
		});

		it("should detect 172.16.0.1 as bogus (private)", () => {
			assert.strictEqual(isBogusIP("172.16.0.1", DEFAULT_BOGUS_RANGES), true);
		});

		it("should detect 169.254.1.1 as bogus (linkLocal)", () => {
			assert.strictEqual(isBogusIP("169.254.1.1", DEFAULT_BOGUS_RANGES), true);
		});

		it("should detect 100.64.0.1 as bogus (carrierGradeNat)", () => {
			assert.strictEqual(isBogusIP("100.64.0.1", DEFAULT_BOGUS_RANGES), true);
		});

		it("should detect 224.0.0.1 as bogus (multicast)", () => {
			assert.strictEqual(isBogusIP("224.0.0.1", DEFAULT_BOGUS_RANGES), true);
		});

		it("should detect 255.255.255.255 as bogus (broadcast)", () => {
			assert.strictEqual(isBogusIP("255.255.255.255", DEFAULT_BOGUS_RANGES), true);
		});

		it("should detect ::1 as bogus (loopback IPv6)", () => {
			assert.strictEqual(isBogusIP("::1", DEFAULT_BOGUS_RANGES), true);
		});

		it("should detect fc00::1 as bogus (uniqueLocal IPv6)", () => {
			assert.strictEqual(isBogusIP("fc00::1", DEFAULT_BOGUS_RANGES), true);
		});

		it("should detect fe80::1 as bogus (linkLocal IPv6)", () => {
			assert.strictEqual(isBogusIP("fe80::1", DEFAULT_BOGUS_RANGES), true);
		});

		it("should not detect 8.8.8.8 as bogus", () => {
			assert.strictEqual(isBogusIP("8.8.8.8", DEFAULT_BOGUS_RANGES), false);
		});

		it("should not detect 1.1.1.1 as bogus", () => {
			assert.strictEqual(isBogusIP("1.1.1.1", DEFAULT_BOGUS_RANGES), false);
		});

		it("should not detect 93.184.216.34 as bogus", () => {
			assert.strictEqual(isBogusIP("93.184.216.34", DEFAULT_BOGUS_RANGES), false);
		});

		it("should return false for invalid IP", () => {
			assert.strictEqual(isBogusIP("not-an-ip", DEFAULT_BOGUS_RANGES), false);
		});

		it("should respect custom bogus ranges", () => {
			assert.strictEqual(isBogusIP("127.0.0.1", ["loopback"]), true);
			assert.strictEqual(isBogusIP("192.168.1.1", ["loopback"]), false);
		});

		it("should return false with empty bogus ranges", () => {
			assert.strictEqual(isBogusIP("127.0.0.1", []), false);
			assert.strictEqual(isBogusIP("0.0.0.0", []), false);
		});
	});

	describe("hasBogusIPs", () => {
		it("should return true if any IP is bogus", () => {
			assert.strictEqual(hasBogusIPs(["8.8.8.8", "127.0.0.1"], DEFAULT_BOGUS_RANGES), true);
		});

		it("should return true if all IPs are bogus", () => {
			assert.strictEqual(hasBogusIPs(["127.0.0.1", "0.0.0.0"], DEFAULT_BOGUS_RANGES), true);
		});

		it("should return false if all IPs are clean", () => {
			assert.strictEqual(hasBogusIPs(["8.8.8.8", "1.1.1.1"], DEFAULT_BOGUS_RANGES), false);
		});

		it("should return false for empty array", () => {
			assert.strictEqual(hasBogusIPs([], DEFAULT_BOGUS_RANGES), false);
		});

		it("should return false for single clean IP", () => {
			assert.strictEqual(hasBogusIPs(["93.184.216.34"], DEFAULT_BOGUS_RANGES), false);
		});
	});

	describe("shouldFilterResolve", () => {
		it("should return true for resolve4", () => {
			assert.strictEqual(shouldFilterResolve("resolve4", ["example.com"]), true);
		});

		it("should return true for resolve6", () => {
			assert.strictEqual(shouldFilterResolve("resolve6", ["example.com"]), true);
		});

		it("should return true for resolve with no rrtype", () => {
			assert.strictEqual(shouldFilterResolve("resolve", ["example.com"]), true);
		});

		it("should return true for resolve with rrtype A", () => {
			assert.strictEqual(shouldFilterResolve("resolve", ["example.com", "A"]), true);
		});

		it("should return true for resolve with rrtype AAAA", () => {
			assert.strictEqual(shouldFilterResolve("resolve", ["example.com", "AAAA"]), true);
		});

		it("should return false for resolve with rrtype MX", () => {
			assert.strictEqual(shouldFilterResolve("resolve", ["example.com", "MX"]), false);
		});

		it("should return false for resolve with rrtype TXT", () => {
			assert.strictEqual(shouldFilterResolve("resolve", ["example.com", "TXT"]), false);
		});

		it("should return false for resolve with rrtype CNAME", () => {
			assert.strictEqual(shouldFilterResolve("resolve", ["example.com", "CNAME"]), false);
		});

		it("should return false for resolveMx", () => {
			assert.strictEqual(shouldFilterResolve("resolveMx", ["example.com"]), false);
		});

		it("should return false for resolveTxt", () => {
			assert.strictEqual(shouldFilterResolve("resolveTxt", ["example.com"]), false);
		});

		it("should return false for resolveCname", () => {
			assert.strictEqual(shouldFilterResolve("resolveCname", ["example.com"]), false);
		});

		it("should return false for reverse", () => {
			assert.strictEqual(shouldFilterResolve("reverse", ["8.8.8.8"]), false);
		});

		it("should return false for resolveNs", () => {
			assert.strictEqual(shouldFilterResolve("resolveNs", ["example.com"]), false);
		});
	});

	describe("resolver bogus filtering integration", () => {
		let mockServer;

		afterEach((done) => {
			if (mockServer) {
				mockServer.close(done);
				mockServer = null;
			} else {
				done();
			}
		});

		it("should return clean results without retrying", (done) => {
			createMockDnsServer(["93.184.216.34"], (server, port) => {
				mockServer = server;
				const resolver = createResolver(["127.0.0.1:" + port]);

				resolver.resolve4("example.com")
					.then((results) => {
						assert.deepStrictEqual(results, ["93.184.216.34"]);
						assert.strictEqual(server.getQueryCount(), 1);
						done();
					})
					.catch(done);
			});
		});

		it("should retry when result contains bogus IP and return clean result", (done) => {
			// First query returns bogus, second returns clean
			createMockDnsServer(["127.0.0.1", "93.184.216.34"], (server, port) => {
				mockServer = server;
				const resolver = createResolver(["127.0.0.1:" + port], {
					maxBogusRetries: 3
				});

				resolver.resolve4("example.com")
					.then((results) => {
						assert.deepStrictEqual(results, ["93.184.216.34"]);
						assert.strictEqual(server.getQueryCount(), 2);
						done();
					})
					.catch(done);
			});
		});

		it("should exhaust retries and return bogus result when all attempts fail", (done) => {
			// All queries return bogus
			createMockDnsServer(["0.0.0.0"], (server, port) => {
				mockServer = server;
				const resolver = createResolver(["127.0.0.1:" + port], {
					maxBogusRetries: 2
				});

				resolver.resolve4("example.com")
					.then((results) => {
						// After 1 initial + 2 retries = 3 total queries, returns the bogus result
						assert.deepStrictEqual(results, ["0.0.0.0"]);
						assert.strictEqual(server.getQueryCount(), 3);
						done();
					})
					.catch(done);
			});
		});

		it("should not filter when bogusRanges is empty", (done) => {
			createMockDnsServer(["127.0.0.1"], (server, port) => {
				mockServer = server;
				const resolver = createResolver(["127.0.0.1:" + port], {
					bogusRanges: []
				});

				resolver.resolve4("example.com")
					.then((results) => {
						assert.deepStrictEqual(results, ["127.0.0.1"]);
						assert.strictEqual(server.getQueryCount(), 1);
						done();
					})
					.catch(done);
			});
		});

		it("should respect custom bogusRanges", (done) => {
			// Only filter loopback, not private
			createMockDnsServer(["192.168.1.1"], (server, port) => {
				mockServer = server;
				const resolver = createResolver(["127.0.0.1:" + port], {
					bogusRanges: ["loopback"]
				});

				resolver.resolve4("example.com")
					.then((results) => {
						// 192.168.1.1 is private but not loopback, should pass through
						assert.deepStrictEqual(results, ["192.168.1.1"]);
						assert.strictEqual(server.getQueryCount(), 1);
						done();
					})
					.catch(done);
			});
		});

		it("should pass through options to factory without error", () => {
			const resolver = createResolver(["8.8.8.8"], {
				bogusRanges: ["loopback"],
				maxBogusRetries: 1
			});

			assert.ok(resolver);
			assert.ok(typeof resolver.resolve4 === "function");
			assert.ok(typeof resolver.resolveMx === "function");
		});
	});
});
