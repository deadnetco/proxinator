const serverImplementation = require("../src/proxy/server").forward;
const reverseClient = require("../src/proxy/client").reverse;

const PORT = 8008;

const server = serverImplementation();

server.on("connection", (connection) => {
	const destination = connection.getDestination();

	console.log("CONNECT", destination.hostname + ":" + destination.port);

	reverseClient(destination).then(socket => {
		connection.bind(socket);
	});
});

server.http.listen(PORT, () => {
	console.log("Forward proxy listening on " + PORT);
	console.log("Test with: curl -x http://127.0.0.1:" + PORT + " https://example.com");
});
