const assert = require("assert");
const createChain = require("../../src/measure/chain");
const createBandwidth = require("../../src/measure/bandwidth");
const createSpeed = require("../../src/measure/speed");

describe("Chain", () => {
	it("should pass data through unchanged", (done) => {
		const stream = createChain([createBandwidth]);
		const input = Buffer.from("hello");

		stream.on("data", (data) => {
			assert.deepStrictEqual(data, input);
			stream.destroy();
			done();
		});

		stream.write(input);
	});

	it("should forward events from inner streams", (done) => {
		const stream = createChain([createBandwidth]);
		let emitted = false;

		stream.on("data", () => {});

		stream.on("bandwidth", (value) => {
			assert.strictEqual(typeof value, "number");
			emitted = true;
		});

		stream.write(Buffer.alloc(100));

		setTimeout(() => {
			assert.ok(emitted);
			stream.destroy();
			done();
		}, 50);
	});

	it("should chain multiple transforms", (done) => {
		const stream = createChain([createBandwidth, createSpeed]);
		let bandwidthEmitted = false;
		let speedEmitted = false;

		stream.on("data", () => {});

		stream.on("bandwidth", () => {
			bandwidthEmitted = true;
		});

		stream.on("speed", () => {
			speedEmitted = true;
		});

		stream.write(Buffer.alloc(200));

		setTimeout(() => {
			assert.ok(bandwidthEmitted);
			assert.ok(speedEmitted);
			stream.destroy();
			done();
		}, 50);
	});
});
