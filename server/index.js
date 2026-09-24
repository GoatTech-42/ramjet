// Ramjet server - static UI + wisp transport on one port.
// GoatTech, 2026. AGPL-3.0.
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join, normalize, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { hostname } from "node:os";
import { server as wisp, logging } from "@mercuryworkshop/wisp-js/server";
import { scramjetPath } from "@mercuryworkshop/scramjet/path";
import { baremuxPath } from "@mercuryworkshop/bare-mux/node";
import { libcurlPath } from "@mercuryworkshop/libcurl-transport";

const PORT = Number(process.env.RAMJET_PORT || 4204);
const HOST = process.env.RAMJET_HOST || "0.0.0.0";
const publicPath = fileURLToPath(new URL("../public/", import.meta.url));

logging.set_level(logging.NONE);
Object.assign(wisp.options, {
	allow_udp_streams: false,
	dns_servers: ["1.1.1.3", "1.0.0.3"],
});

const MIME = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".webp": "image/webp",
	".ico": "image/x-icon",
	".wasm": "application/wasm",
	".json": "application/json",
	".map": "application/json",
	".txt": "text/plain; charset=utf-8",
};

const mounts = [
	{ prefix: "/scram/", root: scramjetPath },
	{ prefix: "/baremux/", root: baremuxPath },
	{ prefix: "/libcurl/", root: libcurlPath },
];

function resolveFile(urlPath) {
	for (const m of mounts) {
		if (urlPath.startsWith(m.prefix)) {
			return join(m.root, normalize(urlPath.slice(m.prefix.length)).replace(/^(\.\.[/\\])+/, ""));
		}
	}
	let p = decodeURIComponent(urlPath.split("?")[0]);
	if (p === "/" || p === "") p = "/index.html";
	return join(publicPath, normalize(p).replace(/^([/\\])+/, "").replace(/^(\.\.[/\\])+/, ""));
}

const server = createServer(async (req, res) => {
	res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
	res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
	try {
		const url = new URL(req.url, "http://x");
		if (url.pathname === "/healthz") {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ ok: true, engine: "scramjet", transport: "wisp", uptime: Math.round(process.uptime()) }));
			return;
		}
		const file = resolveFile(req.url);
		const st = await stat(file).catch(() => null);
		if (!st || !st.isFile()) {
			res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
			res.end("404 - lost in the pasture");
			return;
		}
		const type = MIME[extname(file).toLowerCase()] || "application/octet-stream";
		const headers = { "content-type": type, "content-length": st.size, "cache-control": "no-cache" };
		if (file.endsWith("sw.js")) headers["service-worker-allowed"] = "/";
		res.writeHead(200, headers);
		res.end(await readFile(file));
	} catch (err) {
		res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
		res.end("500 - ramjet misfire");
	}
});

server.on("upgrade", (req, socket, head) => {
	if (req.url.endsWith("/wisp/")) wisp.routeRequest(req, socket, head);
	else socket.end();
});

function shutdown() {
	console.log("ramjet: shutting down");
	server.close(() => process.exit(0));
	setTimeout(() => process.exit(0), 3000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

server.listen(PORT, HOST, () => {
	console.log(`ramjet: listening on http://${hostname()}:${PORT} (bind ${HOST}:${PORT})`);
});
