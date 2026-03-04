const serverImplementation = require("../src/proxy/server").reverse;
const reverseClient = require("../src/proxy/client").reverse;

const PORT = 8008;

const server = serverImplementation();

server.on("connection", (connection) => {
	connection.waitSNI().then(domain => {
		console.log("SNI", domain);

		const url = new URL("tcp://" + domain + ":443");

		reverseClient(url).then(socket => {
			connection.bind(socket);
		});
	});
});

server.tcp.listen(PORT, () => {
	console.log("Reverse proxy listening on " + PORT);
	console.log("Test with: curl --resolve example.com:8008:127.0.0.1 https://example.com:8008");
});
