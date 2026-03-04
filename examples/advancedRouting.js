const proxinator = require("../src");

const PROXY_URL = new URL("http://user:pass@proxy.example.com:8080");
const PORT = 8008;

const DIRECT_DOMAINS = [
	"cdninstagram.com",
	"static.xx.fbcdn.net"
];

const server = proxinator.server.forward();

server.on("connection", (connection) => {
	const destination = connection.getDestination();
	const domain = destination.hostname;

	if(DIRECT_DOMAINS.indexOf(domain) !== -1) {
		console.log("DIRECT", domain);

		return proxinator.client.reverse(destination).then(socket => {
			connection.bind(socket);
		});
	}

	console.log("PROXY", domain);

	proxinator.client.forward(PROXY_URL, destination).then(socket => {
		connection.bind(socket);
	});
});

server.http.listen(PORT, () => {
	console.log("Advanced routing proxy listening on " + PORT);
	console.log("Direct domains:", DIRECT_DOMAINS.join(", "));
	console.log("All other traffic routed through " + PROXY_URL.host);
	console.log("Test with: curl -x http://127.0.0.1:" + PORT + " https://example.com");
});
