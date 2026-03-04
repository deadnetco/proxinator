const forwardClient = require("../src/proxy/client").forward;

const proxy = new URL("http://user:pass@proxy.example.com:8080");
const url = new URL("tcp://example.com:443");

console.log("Connecting to " + url.host + " through " + proxy.host + "...");

forwardClient(proxy, url).then(socket => {
	console.log("Connected:", socket.remoteAddress + ":" + socket.remotePort);

	socket.on("data", (data) => {
		console.log("Received", data.length, "bytes");
	});

	socket.on("close", () => {
		console.log("Connection closed");
	});
}).catch(error => {
	console.error("Error:", error.message);
});
