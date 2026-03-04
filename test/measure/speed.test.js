const assert = require("assert");
const createSpeed = require("../../src/measure/speed");

describe("Speed", () => {
	it("should start at zero", () => {
		const stream = createSpeed();
		assert.strictEqual(stream.getSpeed(), 0);
		stream.destroy();
	});

	it("should return a number after writing data", (done) => {
		const stream = createSpeed();

		stream.on("data", () => {});

		stream.write(Buffer.alloc(1000));

		setTimeout(() => {
			const speed = stream.getSpeed();
			assert.strictEqual(typeof speed, "number");
			assert.ok(speed > 0);
			stream.destroy();
			done();
		}, 50);
	});

	it("should emit speed events", (done) => {
		const stream = createSpeed();
		let emitted = false;

		stream.on("data", () => {});

		stream.on("speed", (value) => {
			assert.strictEqual(typeof value, "number");
			emitted = true;
		});

		stream.write(Buffer.alloc(500));

		setTimeout(() => {
			assert.ok(emitted);
			stream.destroy();
			done();
		}, 50);
	});

	it("should pass data through unchanged", (done) => {
		const stream = createSpeed();
		const input = Buffer.from("test data");

		stream.on("data", (data) => {
			assert.deepStrictEqual(data, input);
			stream.destroy();
			done();
		});

		stream.write(input);
	});
});
