/**
 * Write a fixed number of bytes to a stream, respecting backpressure.
 */

/** @type {Buffer} Reused payload chunk */
const CHUNK = Buffer.alloc(64 * 1024, 0x61);

/**
 * @param {stream.Writable} stream - Destination
 * @param {number} total - Bytes to write
 * @param {Function} [callback] - Called once every byte has been handed to the stream
 */
module.exports = (stream, total, callback) => {
	let sent = 0;

	const pump = () => {
		while (sent < total) {
			const size = Math.min(CHUNK.length, total - sent);
			sent += size;

			if (!stream.write(CHUNK.subarray(0, size))) {
				stream.once("drain", pump);
				return;
			}
		}

		if (callback) {
			callback();
		}
	};

	pump();
};
