const assert = require("assert");
const nipio = require("../../src/utils/obfuscator/nipio");

describe("nip.io", () => {
	it("should convert IPv4 to hex nip.io hostname", () => {
		assert.strictEqual(nipio.fromIP("10.0.0.1"), "0a000001.nip.io");
	});

	it("should auto-detect IPv4 and return hex nip.io", () => {
		return nipio.convert("192.168.1.1").then((result) => {
			assert.strictEqual(result, "c0a80101.nip.io");
		});
	});

	it("should reject IPv6 addresses", () => {
		return nipio.convert("::1").then(() => {
			throw new Error("Should have rejected");
		}).catch((error) => {
			assert.ok(error.message.includes("IPv4"));
		});
	});

	it("should resolve hostname and return nip.io", () => {
		return nipio.convert("example.com").then((result) => {
			assert.ok(result.endsWith(".nip.io"));
			assert.notStrictEqual(result, "example.com.nip.io");
		});
	});
});
