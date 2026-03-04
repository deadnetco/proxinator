/**
 * Chain multiple transform stream factories into a single transform.
 * Data flows through the original stream and through the chained transforms.
 * Events from inner streams are forwarded to the outer transform.
 * @module measure/chain
 */
const Transform = require("stream").Transform;

/**
 * Create a chained transform from an array of transform factories
 * @param {function[]} array - Array of transform factory functions
 * @returns {Transform} Combined transform stream that forwards events from inner streams
 */
module.exports = (array) => {
	const streams = array.map(el => el());

	streams[streams.length - 1].on("data", () => {});

	streams.reduce((prev, cur) => {
		if(prev != null) {
			prev.pipe(cur);
		}

		return cur;
	}, null);

	const transform = new Transform({
		transform(chunk, encoding, callback) {
			let buffer = chunk;

			if(encoding !== "buffer") {
				buffer = Buffer.from(buffer, encoding);
			}

			streams[0].write(buffer);

			callback(null, chunk);
		},
	});

	const originalOn = transform.on;
	const originalOnce = transform.once;

	transform.on = (chan, callback) => {
		if(chan !== "data") {
			streams.forEach(stream => {
				stream.on(chan, callback);
			});
		}

		return originalOn.call(transform, chan, callback);
	};

	transform.once = (chan, callback) => {
		if(chan !== "data") {
			streams.forEach(stream => {
				stream.once(chan, callback);
			});
		}

		return originalOnce.call(transform, chan, callback);
	};

	return transform;
};
