const assert = require("assert");
const createBandwidth = require("../../src/measure/bandwidth");

describe("Bandwidth", () => {
	it("should start at zero", () => {
		const stream = createBandwidth();
		assert.strictEqual(stream.getBandwidth(), 0);
		stream.destroy();
	});

	it("should track total bytes", (done) => {
		const stream = createBandwidth();

		stream.on("data", () => {});

		stream.write(Buffer.alloc(100));
		stream.write(Buffer.alloc(50));

		setTimeout(() => {
			assert.strictEqual(stream.getBandwidth(), 150);
			stream.destroy();
			done();
		}, 50);
	});

	it("should emit bandwidth events", (done) => {
		const stream = createBandwidth();
		const values = [];

		stream.on("data", () => {});

		stream.on("bandwidth", (value) => {
			values.push(value);
		});

		stream.write(Buffer.alloc(100));
		stream.write(Buffer.alloc(200));

		setTimeout(() => {
			assert.strictEqual(values.length, 2);
			assert.strictEqual(values[0], 100);
			assert.strictEqual(values[1], 300);
			stream.destroy();
			done();
		}, 50);
	});

	it("should pass data through unchanged", (done) => {
		const stream = createBandwidth();
		const input = Buffer.from("hello world");

		stream.on("data", (data) => {
			assert.deepStrictEqual(data, input);
			stream.destroy();
			done();
		});

		stream.write(input);
	});
});
