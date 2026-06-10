/**
 * Slowdown throttle transform stream.
 * Paces data through to a target throughput (bytes/sec) by delaying each chunk,
 * and emits "slowdown" events with the applied delay. The inverse of the speed
 * and bandwidth meters: those measure throughput, this one limits it.
 * @module measure/slowdown
 */
const Transform = require("stream").Transform;

/** @type {number} Default throttle rate in bytes per second */
const DEFAULT_RATE = 1024 * 1024;

/**
 * Create a slowdown throttle transform stream
 * @param {number} [rateOptional] - Target throughput in bytes per second (defaults to DEFAULT_RATE)
 * @returns {Transform} Transform stream with getRate() method, emits "slowdown" events
 */
module.exports = (rateOptional) => {
	const rate = rateOptional || DEFAULT_RATE;

	const transform = new Transform({
		transform(chunk, encoding, callback) {
			let buffer = chunk;

			if(encoding !== "buffer") {
				buffer = Buffer.from(buffer, encoding);
			}

			const delay = (buffer.length / rate) * 1000;

			transform.emit("slowdown", delay);

			setTimeout(() => {
				callback(null, chunk);
			}, delay);
		},
	});

	/** @returns {number} Configured throttle rate in bytes per second */
	transform.getRate = () => rate;

	return transform;
};
