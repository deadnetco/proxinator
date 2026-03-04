const assert = require("assert");
const createPool = require("../../src/utils/balancer");

describe("Balancer", () => {
	describe("push", () => {
		it("should add a candidate with default weight", () => {
			const pool = createPool();
			pool.push("server-a");
			assert.deepStrictEqual(pool.getAllCandidates(), ["server-a"]);
		});

		it("should add multiple candidates", () => {
			const pool = createPool();
			pool.push("server-a");
			pool.push("server-b");
			assert.deepStrictEqual(pool.getAllCandidates(), ["server-a", "server-b"]);
		});
	});

	describe("addMany", () => {
		it("should add multiple candidates at once", () => {
			const pool = createPool();
			pool.addMany([
				{ candidate: "server-a", weight: 2 },
				{ candidate: "server-b", weight: 1 }
			]);
			assert.deepStrictEqual(pool.getAllCandidates(), ["server-a", "server-b"]);
		});
	});

	describe("delete", () => {
		it("should remove a candidate", () => {
			const pool = createPool();
			pool.push("server-a");
			pool.push("server-b");
			pool.delete("server-a");
			assert.deepStrictEqual(pool.getAllCandidates(), ["server-b"]);
		});

		it("should do nothing if candidate not found", () => {
			const pool = createPool();
			pool.push("server-a");
			pool.delete("nonexistent");
			assert.deepStrictEqual(pool.getAllCandidates(), ["server-a"]);
		});
	});

	describe("getRandomCandidate", () => {
		it("should return a candidate from the pool", () => {
			const pool = createPool();
			pool.push("server-a");
			pool.push("server-b");
			const result = pool.getRandomCandidate();
			assert.ok(["server-a", "server-b"].includes(result));
		});

		it("should return the only candidate if pool has one", () => {
			const pool = createPool();
			pool.push("server-a");
			assert.strictEqual(pool.getRandomCandidate(), "server-a");
		});

		it("should use seed for deterministic selection", () => {
			const pool = createPool();
			pool.push("server-a");
			pool.push("server-b");
			const result1 = pool.getRandomCandidate(0);
			const result2 = pool.getRandomCandidate(0);
			assert.strictEqual(result1, result2);
		});

		it("should respect weights in distribution", () => {
			const pool = createPool();
			pool.push("heavy", 100);
			pool.push("light", 1);

			const counts = { heavy: 0, light: 0 };
			const iterations = 1000;

			Array(iterations).fill().forEach(() => {
				const result = pool.getRandomCandidate();
				counts[result]++;
			});

			// Heavy should get significantly more hits
			assert.ok(counts.heavy > counts.light * 5);
		});
	});

	describe("getAllCandidates", () => {
		it("should return empty array for empty pool", () => {
			const pool = createPool();
			assert.deepStrictEqual(pool.getAllCandidates(), []);
		});
	});
});
