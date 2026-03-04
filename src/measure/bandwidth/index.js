/**
 * Bandwidth measurement transform stream.
 * Tracks total bytes transferred and emits "bandwidth" events.
 * @module measure/bandwidth
 */
const Transform = require("stream").Transform;

/**
 * Create a bandwidth measurement transform stream
 * @returns {Transform} Transform stream with getBandwidth() method, emits "bandwidth" events
 */
module.exports = () => {
	let measurement = 0;

	const transform = new Transform({
		transform(chunk, encoding, callback) {
			let buffer = chunk;

			if(encoding !== "buffer") {
				buffer = Buffer.from(buffer, encoding);
			}

			measurement += buffer.length;

			transform.emit("bandwidth", transform.getBandwidth());

			callback(null, chunk);
		},
	});

	/** @returns {number} Total bytes transferred */
	transform.getBandwidth = () => measurement;

	return transform;
};
