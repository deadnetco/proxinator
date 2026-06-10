const assert = require("assert");
const createSlowdown = require("../../src/measure/slowdown");

describe("Slowdown", () => {
	it("should expose the configured rate", () => {
		const stream = createSlowdown(5000);
		assert.strictEqual(stream.getRate(), 5000);
		stream.destroy();
	});

	it("should fall back to a default rate", () => {
		const stream = createSlowdown();
		assert.ok(stream.getRate() > 0);
		stream.destroy();
	});

	it("should pass data through unchanged", (done) => {
		const stream = createSlowdown(1000000);
		const input = Buffer.from("test data");

		stream.on("data", (data) => {
			assert.deepStrictEqual(data, input);
			stream.destroy();
			done();
		});

		stream.write(input);
	});

	it("should delay output according to the rate", (done) => {
		// 1000 bytes at 10000 bytes/sec should take roughly 100ms.
		const stream = createSlowdown(10000);
		const start = performance.now();

		stream.on("data", () => {
			const elapsed = performance.now() - start;
			assert.ok(elapsed >= 90, "expected throttle delay, got " + elapsed + "ms");
			stream.destroy();
			done();
		});

		stream.write(Buffer.alloc(1000));
	});

	it("should emit slowdown events with the applied delay", (done) => {
		const stream = createSlowdown(10000);
		let emitted;

		stream.on("data", () => {});

		stream.on("slowdown", (delay) => {
			emitted = delay;
		});

		stream.write(Buffer.alloc(1000));

		setTimeout(() => {
			assert.strictEqual(typeof emitted, "number");
			assert.ok(emitted > 0);
			stream.destroy();
			done();
		}, 200);
	});
});
