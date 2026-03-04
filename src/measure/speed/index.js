/**
 * Speed measurement transform stream.
 * Measures throughput (bytes/sec) over a rolling window and emits "speed" events.
 * @module measure/speed
 */
const Transform = require("stream").Transform;

/** @type {number} Rolling window duration in seconds for speed averaging */
const AVERAGE_DURATION = 5;

/**
 * Create a speed measurement transform stream
 * @returns {Transform} Transform stream with getSpeed() method, emits "speed" events
 */
module.exports = () => {
	const measurements = {};

	/**
	 * Remove measurement entries older than the rolling window
	 * @param {number} now - Current time in seconds
	 */
	const prune = (now) => {
		Object.keys(measurements).forEach((time) => {
			if(+time < now - AVERAGE_DURATION) {
				delete measurements[+time];
			}
		});
	};

	const transform = new Transform({
		transform(chunk, encoding, callback) {
			let buffer = chunk;

			if(encoding !== "buffer") {
				buffer = Buffer.from(buffer, encoding);
			}

			const now = Math.floor(performance.now() / 1000);

			prune(now);

			measurements[now] = measurements[now] || 0;

			measurements[now] += buffer.length;

			transform.emit("speed", transform.getSpeed());

			callback(null, chunk);
		},
	});

	/**
	 * Get the average speed over the rolling window
	 * @returns {number} Bytes per second
	 */
	transform.getSpeed = () => {
		const now = Math.floor(performance.now() / 1000);

		prune(now);

		const speed = Object.keys(measurements).reduce((prev, cur) => {
			return prev + measurements[cur];
		}, 0) / AVERAGE_DURATION;

		return speed;
	};

	return transform;
};
