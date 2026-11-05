/**
 * Tunnel - pipes two sockets into each other with consistent teardown.
 * Shared by the forward, reverse and SOCKS5 servers' bind().
 *
 * - A half-close (FIN) from one peer is forwarded with end(), so bytes still
 *   buffered in the pipe drain instead of being thrown away.
 * - Any error aborts the tunnel: both sockets are destroyed.
 * - Benign teardown errors are not reported.
 * - Optional idle timeout destroys a tunnel with no traffic in either direction.
 */

/** @type {string[]} Error codes that are normal teardown noise, not worth reporting */
const BENIGN_ERRORS = ["ECONNRESET", "EPIPE", "ERR_STREAM_WRITE_AFTER_END"];

/**
 * Pipe a client socket and a target socket into each other
 * @param {net.Socket} clientSocket - Socket accepted by the proxy server
 * @param {net.Socket} socket - Socket to the target
 * @param {Object} [options] - Optional settings
 * @param {stream.Transform} [options.up] - Transform for target-to-client data
 * @param {stream.Transform} [options.down] - Transform for client-to-target data
 * @param {number} [options.idleTimeout] - Destroy the tunnel after this many ms with no traffic (0 or omitted: never)
 * @param {Function} [options.onError] - Called with errors that are not benign teardown noise
 * @param {Function} [options.onTimeout] - Called when the idle timeout destroys the tunnel
 */
module.exports = (clientSocket, socket, options) => {
	const opts = options || {};

	socket.allowHalfOpen = true;
	clientSocket.allowHalfOpen = true;

	const destroy = () => {
		socket.destroy();
		clientSocket.destroy();
	};

	clientSocket.on("close", () => {
		socket.end();
	});

	socket.on("close", () => {
		clientSocket.end();
	});

	socket.on("end", () => {
		clientSocket.end();
	});

	clientSocket.on("end", () => {
		socket.end();
	});

	// An error means the connection is already broken, so abort with destroy()
	// on both sides. end() (graceful flush) is only correct for a clean close.
	const onError = (error) => {
		if (BENIGN_ERRORS.indexOf(error.code) === -1 && opts.onError) {
			opts.onError(error);
		}

		destroy();
	};

	clientSocket.on("error", onError);
	socket.on("error", onError);

	// Socket timeouts reset on reads and writes, and every chunk is read on one
	// socket and written on the other, so traffic in either direction keeps
	// both alive.
	if (opts.idleTimeout > 0) {
		let timedOut = false;

		const onIdle = () => {
			if (timedOut) {
				return;
			}

			timedOut = true;
			destroy();

			if (opts.onTimeout) {
				opts.onTimeout();
			}
		};

		[clientSocket, socket].forEach((each) => {
			each.setTimeout(opts.idleTimeout);
			each.on("timeout", onIdle);
		});
	}

	if (opts.up) {
		socket.pipe(opts.up);
		opts.up.pipe(clientSocket);
	} else {
		socket.pipe(clientSocket);
	}

	if (opts.down) {
		clientSocket.pipe(opts.down);
		opts.down.pipe(socket);
	} else {
		clientSocket.pipe(socket);
	}

	clientSocket.resume();
	socket.resume();
};
