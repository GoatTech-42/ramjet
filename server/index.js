// Ramjet server - static UI + wisp transport on one port, password-gated.
// GoatTech, 2026. MIT.
import { createServer } from "node:http";
import { readFile, stat, writeFile, mkdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join, normalize, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { hostname } from "node:os";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { server as wisp, logging } from "@mercuryworkshop/wisp-js/server";
import { scramjetPath } from "@mercuryworkshop/scramjet/path";
import { baremuxPath } from "@mercuryworkshop/bare-mux/node";
import { libcurlPath } from "@mercuryworkshop/libcurl-transport";

const PORT = Number(process.env.RAMJET_PORT || 4204);
const HOST = process.env.RAMJET_HOST || "0.0.0.0";
const publicPath = fileURLToPath(new URL("../public/", import.meta.url));
const DATA_DIR = process.env.RAMJET_DATA_DIR || "/home/luke/goattech/ramjet-data";
const PASSWORD_HASH_FILE = join(DATA_DIR, "password.hash");
const SESSIONS_FILE = join(DATA_DIR, "sessions.json");
const GUARD_FILE = join(DATA_DIR, "login-guard.json");
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
const MAX_LOGIN_FAILS = 5;
const LOGIN_LOCKOUT_MS = 15 * 60 * 1000;

logging.set_level(logging.NONE);
Object.assign(wisp.options, {
	allow_udp_streams: false,
	dns_servers: ["1.1.1.3", "1.0.0.3"],
});

// -- auth ------------------------------------------------------------------
// Same salted scrypt format as the mc-headless dashboard: "<salt hex>$<scrypt hex>".
// The hash file is copied from the dashboard config; the password itself is
// never stored or logged here.
function loadPasswordHash() {
	try {
		const t = readFileSync(PASSWORD_HASH_FILE, "utf8").trim();
		if (/^[0-9a-f]{32}\$[0-9a-f]{64}$/.test(t)) return t;
		console.error("ramjet: password hash file has unexpected format");
	} catch {
		console.error("ramjet: no password hash at " + PASSWORD_HASH_FILE);
	}
	return "";
}
function verifyPassword(pw, stored) {
	const parts = (stored || "").split("$");
	if (parts.length !== 2 || !pw) return false;
	const cand = scryptSync(pw, parts[0], 32);
	const want = Buffer.from(parts[1], "hex");
	return cand.length === want.length && timingSafeEqual(cand, want);
}
const PASSWORD_HASH = loadPasswordHash();

function readJson(p, dflt) { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return dflt; } }
async function writeJson(p, v) { try { await writeFile(p, JSON.stringify(v), { mode: 0o600 }); } catch {} }

function sessionFrom(req) {
	const m = /(?:^|;\s*)rj_session=([0-9a-f]{64})/.exec(req.headers.cookie || "");
	if (!m) return null;
	const sessions = readJson(SESSIONS_FILE, {});
	const exp = sessions[m[1]];
	if (!exp) return null;
	if (Date.now() > exp) { delete sessions[m[1]]; writeJson(SESSIONS_FILE, sessions); return null; }
	return m[1];
}
async function newSession(res) {
	const token = randomBytes(32).toString("hex");
	const sessions = readJson(SESSIONS_FILE, {});
	sessions[token] = Date.now() + SESSION_TTL_MS;
	// prune expired
	for (const k of Object.keys(sessions)) if (sessions[k] < Date.now()) delete sessions[k];
	await writeJson(SESSIONS_FILE, sessions);
	res.setHeader("Set-Cookie", `rj_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`);
}
async function killSession(req, res) {
	const token = sessionFrom(req);
	if (token) { const s = readJson(SESSIONS_FILE, {}); delete s[token]; await writeJson(SESSIONS_FILE, s); }
	res.setHeader("Set-Cookie", "rj_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
}

const PUBLIC_PREFIXES = ["/login", "/auth/login", "/auth/logout", "/healthz", "/assets/", "/style.css", "/favicon"];
function isPublic(pathname) {
	return PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(p.endsWith("/") ? p : p + "?"));
}

// -- static ------------------------------------------------------------------
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
	if (p === "/login") p = "/login.html";
	if (p === "/" || p === "") p = "/index.html";
	return join(publicPath, normalize(p).replace(/^([/\\])+/, "").replace(/^(\.\.[/\\])+/, ""));
}

function clientIp(req) {
	return (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "unknown";
}

function readBody(req) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		req.on("data", (c) => {
			size += c.length;
			if (size > 4096) { reject(new Error("body too big")); req.destroy(); return; }
			chunks.push(c);
		});
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		req.on("error", reject);
	});
}

async function handleLogin(req, res) {
	const ip = clientIp(req);
	const guard = readJson(GUARD_FILE, {});
	const g = guard[ip] || { fails: 0, locked_until: 0 };
	const now = Date.now();
	if (g.locked_until && now < g.locked_until) {
		res.writeHead(303, { location: "/login?locked=1" });
		res.end();
		return;
	}
	let pw = "";
	try {
		const body = await readBody(req);
		pw = new URLSearchParams(body).get("password") || "";
	} catch {}
	if (PASSWORD_HASH && verifyPassword(pw, PASSWORD_HASH)) {
		guard[ip] = { fails: 0, locked_until: 0 };
		await writeJson(GUARD_FILE, guard);
		await newSession(res);
		res.writeHead(303, { location: "/" });
		res.end();
		return;
	}
	// slow the retry loop a little
	await new Promise((r) => setTimeout(r, 800 + Math.floor(Math.random() * 700)));
	g.fails += 1;
	if (g.fails >= MAX_LOGIN_FAILS) { g.locked_until = Date.now() + LOGIN_LOCKOUT_MS; g.fails = 0; }
	guard[ip] = g;
	await writeJson(GUARD_FILE, guard);
	res.writeHead(303, { location: "/login?bad=1" });
	res.end();
}

const server = createServer(async (req, res) => {
	res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
	res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
	try {
		const url = new URL(req.url, "http://x");
		const pathname = url.pathname;
		if (pathname === "/healthz") {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ ok: true, engine: "scramjet", transport: "wisp", uptime: Math.round(process.uptime()) }));
			return;
		}
		if (pathname === "/auth/login" && req.method === "POST") return await handleLogin(req, res);
		if (pathname === "/auth/logout") {
			await killSession(req, res);
			res.writeHead(303, { location: "/login" });
			res.end();
			return;
		}
		if (!isPublic(pathname) && !sessionFrom(req)) {
			if (req.method === "GET" || req.method === "HEAD") {
				res.writeHead(303, { location: "/login" });
				res.end();
			} else {
				res.writeHead(401, { "content-type": "text/plain; charset=utf-8" });
				res.end("locked");
			}
			return;
		}
		const file = resolveFile(pathname);
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
	if (req.url.endsWith("/wisp/") && sessionFrom(req)) wisp.routeRequest(req, socket, head);
	else socket.destroy();
});

function shutdown() {
	console.log("ramjet: shutting down");
	server.close(() => process.exit(0));
	setTimeout(() => process.exit(0), 3000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await mkdir(DATA_DIR, { recursive: true }).catch(() => {});
server.listen(PORT, HOST, () => {
	console.log(`ramjet: listening on http://${hostname()}:${PORT} (bind ${HOST}:${PORT}, gate ${PASSWORD_HASH ? "armed" : "UNARMED"})`);
});
