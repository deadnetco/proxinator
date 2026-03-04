const assert = require("assert");
const createIP = require("../../src/utils/ip");
const ipToHex = require("../../src/utils/ip").ipToHex;
const isIP = require("../../src/utils/ip").isIP;
const normalizeAddress = require("../../src/utils/ip").normalizeAddress;
const normalizeFamily = require("../../src/utils/ip").normalizeFamily;

describe("IP Utilities", () => {
	describe("IPv4", () => {
		it("should parse IPv4 address", () => {
			const ip = createIP("192.168.1.1");
			assert.strictEqual(ip.kind(), "ipv4");
		});

		it("should convert to string", () => {
			const ip = createIP("192.168.1.1");
			assert.strictEqual(ip.toString(), "192.168.1.1");
		});

		it("should apply mask correctly", () => {
			const ip = createIP("192.168.1.100");
			assert.strictEqual(ip.mask(24), "192.168.1.0");
			assert.strictEqual(ip.mask(16), "192.168.0.0");
			assert.strictEqual(ip.mask(8), "192.0.0.0");
		});

		it("should generate all possible nets", () => {
			const ip = createIP("10.0.0.1");
			const nets = ip.nets();
			assert.strictEqual(nets.length, 32);
			assert.ok(nets[0].endsWith("/1"));
			assert.ok(nets[31].endsWith("/32"));
		});
	});

	describe("ipToHex", () => {
		it("should convert IPv4 to hex string", () => {
			assert.strictEqual(ipToHex("192.168.1.1"), "c0a80101");
		});

		it("should pad single-digit octets", () => {
			assert.strictEqual(ipToHex("10.0.0.1"), "0a000001");
		});

		it("should handle 255.255.255.255", () => {
			assert.strictEqual(ipToHex("255.255.255.255"), "ffffffff");
		});
	});

	describe("isIP", () => {
		it("should return 4 for IPv4 URL", () => {
			assert.strictEqual(isIP("http://192.168.1.1/path"), 4);
		});

		it("should return 6 for IPv6 URL", () => {
			assert.strictEqual(isIP("http://[::1]/path"), 6);
		});

		it("should return 0 for hostname URL", () => {
			assert.strictEqual(isIP("http://example.com/path"), 0);
		});

		it("should accept URL instance", () => {
			assert.strictEqual(isIP(new URL("http://10.0.0.1")), 4);
		});
	});

	describe("normalizeAddress", () => {
		it("should strip ::ffff: prefix", () => {
			assert.strictEqual(normalizeAddress("::ffff:127.0.0.1"), "127.0.0.1");
		});

		it("should leave plain IPv4 unchanged", () => {
			assert.strictEqual(normalizeAddress("192.168.1.1"), "192.168.1.1");
		});

		it("should leave plain IPv6 unchanged", () => {
			assert.strictEqual(normalizeAddress("::1"), "::1");
		});
	});

	describe("normalizeFamily", () => {
		it("should return IPv4 for mapped address", () => {
			assert.strictEqual(normalizeFamily("::ffff:127.0.0.1", "IPv6"), "IPv4");
		});

		it("should return original family for plain IPv4", () => {
			assert.strictEqual(normalizeFamily("192.168.1.1", "IPv4"), "IPv4");
		});

		it("should return original family for plain IPv6", () => {
			assert.strictEqual(normalizeFamily("::1", "IPv6"), "IPv6");
		});
	});

	describe("IPv6", () => {
		it("should parse IPv6 address", () => {
			const ip = createIP("2001:db8::1");
			assert.strictEqual(ip.kind(), "ipv6");
		});

		it("should convert to string", () => {
			const ip = createIP("2001:db8::1");
			assert.strictEqual(ip.toString(), "2001:db8::1");
		});

		it("should generate 128 nets for IPv6", () => {
			const ip = createIP("2001:db8::1");
			const nets = ip.nets();
			assert.strictEqual(nets.length, 128);
		});
	});
});
