/**
 * Weighted random load balancer.
 * @module utils/balancer
 */

/**
 * @typedef {object} Pool
 * @property {function} calculateWeights - Recalculate weights
 * @property {function} push - Add a candidate
 * @property {function} addMany - Add multiple candidates at once
 * @property {function} delete - Remove a candidate
 * @property {function} getRandomCandidate - Get a weighted random candidate
 * @property {function} getAllCandidates - Get all candidates
 */

/**
 * Create a weighted random balancer pool
 * @returns {Pool}
 */
module.exports = () => {
	let candidates = [];
	let weights = [];

	const pool = {
		_weights: [],
		_weightMap: [],
		_max: 0,

		/**
		 * Recalculate internal weight distribution
		 */
		calculateWeights: () => {
			const min = Math.min(...weights);

			const weightsMap = weights.map(size => size / min);

			pool._weights = weightsMap;

			let pointer = 0;
			const weightMap = [];

			weightsMap.forEach((weight) => {
				pointer += weight;

				weightMap.push(pointer);
			});

			pool._weightMap = weightMap;
			pool._max = pointer;
		},

		/**
		 * Add a candidate to the pool
		 * @param {*} candidate - Candidate to add
		 * @param {number} [weight=1] - Weight for this candidate
		 */
		push: (candidate, weight) => {
			candidates.push(candidate);
			weights.push(weight || 1);

			pool.calculateWeights();
		},

		/**
		 * Add multiple candidates at once (recalculates weights once at the end)
		 * @param {Array<{candidate: *, weight?: number}>} items - Array of candidates with optional weights
		 */
		addMany: (items) => {
			items.forEach((item) => {
				candidates.push(item.candidate);
				weights.push(item.weight || 1);
			});

			pool.calculateWeights();
		},

		/**
		 * Remove a candidate from the pool
		 * @param {*} candidate - Candidate to remove
		 */
		delete: (candidate) => {
			const index = candidates.indexOf(candidate);

			if(index === -1) {
				return;
			}

			candidates = candidates.slice(0, index).concat(candidates.slice(index + 1, candidates.length));
			weights = weights.slice(0, index).concat(weights.slice(index + 1, weights.length));

			pool.calculateWeights();
		},

		/**
		 * Get a weighted random candidate
		 * @param {number} [seed] - Optional seed for deterministic selection
		 * @returns {*} Selected candidate
		 */
		getRandomCandidate: (seed) => {
			const netPointer = (seed === undefined)?(Math.random() * pool._max):(seed % pool._max);

			const nets = candidates.filter((_, key) => {
				return netPointer < pool._weightMap[key];
			});

			const net = nets[0];

			return net;
		},

		/**
		 * Get all candidates in the pool
		 * @returns {Array} All candidates
		 */
		getAllCandidates: () => {
			return candidates;
		}
	};

	return pool;
};
