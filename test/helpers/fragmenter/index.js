/**
 * Test helper - wraps a connected TCP socket in a Duplex that splits every
 * write into small pieces sent as separate TCP segments.
 *
 * Loopback has a 64K MTU, so a ClientHello written there always arrives in
 * one segment. Passing this Duplex to tls.connect({ socket }) reproduces what
 * a real network does to a ClientHello larger than the MSS.
 */
const Duplex = require("stream").Duplex;

/**
 * @param {net.Socket} socket - Connected TCP socket
 * @param {number} size - Max bytes per segment
 * @param {number} delay - Pause between segments in ms (keeps them from coalescing)
 * @returns {stream.Duplex}
 */
module.exports = (socket, size, delay) => {
	socket.setNoDelay(true);

	const sendPieces = (chunk, callback) => {
		socket.write(chunk.subarray(0, size));

		const rest = chunk.subarray(size);

		if (rest.length === 0) {
			return callback();
		}

		setTimeout(() => {
			sendPieces(rest, callback);
		}, delay);
	};

	const duplex = new Duplex({
		write: (chunk, _encoding, callback) => {
			sendPieces(chunk, callback);
		},

		read: () => {
			socket.resume();
		},

		final: (callback) => {
			socket.end(callback);
		},

		destroy: (error, callback) => {
			socket.destroy();
			callback(error);
		}
	});

	socket.on("data", (data) => {
		if (!duplex.push(data)) {
			socket.pause();
		}
	});

	socket.on("end", () => {
		duplex.push(null);
	});

	socket.on("error", (error) => {
		duplex.destroy(error);
	});

	return duplex;
};
