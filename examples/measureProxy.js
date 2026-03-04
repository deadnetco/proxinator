const proxinator = require("../src");

const PORT = 8008;

const server = proxinator.server.forward();

server.on("connection", (connection) => {
	const destination = connection.getDestination();
	const domain = destination.hostname;

	const meter = proxinator.measure.chain([
		proxinator.measure.bandwidth,
		proxinator.measure.speed
	]);

	meter.on("bandwidth", (total) => {
		console.log(domain, "total:", total, "bytes");
	});

	meter.on("speed", (bps) => {
		console.log(domain, "speed:", Math.round(bps), "bytes/sec");
	});

	proxinator.client.reverse(destination).then(socket => {
		connection.bind(socket, meter);
	});
});

server.http.listen(PORT, () => {
	console.log("Measuring proxy listening on " + PORT);
	console.log("Test with: curl -x http://127.0.0.1:" + PORT + " https://example.com");
});
