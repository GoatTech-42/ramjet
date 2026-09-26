// Ramjet server - static UI + wisp transport on one port, password-gated.
// GoatTech, 2026. MIT.
// v1.1: split into modules - util.js (helpers), auth.js (accounts/sessions/sync),
// addons.js (addon registry + dispatch). This file is bootstrap + routing only.
import { createServer, request as httpRequest } from "node:http";
import { gzipSync } from "node:zlib";
import { readFile, stat, mkdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join, normalize, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { hostname } from "node:os";
import { server as wisp, logging } from "@mercuryworkshop/wisp-js/server";
import { DATA_DIR, readJson, writeJson, loadConfig, json, bodyParams, MIME } from "./util.js";
import { sessionRecord, sessionFrom, killSession, isPublic, readAccounts, writeAccounts, readLastSeen, handleLogin, handleSignup, handleSync, handleWipeOnClose, handleWipeStatus, handlePasswd, passwordArmed } from "./auth.js";
import { listAddons, dispatchAddonApi, serveAddonStatic } from "./addons.js";
import { handle as searchHandle, thumb as searchThumb } from "./searchpage.js";

const libcurlPath = join(fileURLToPath(new URL(".", import.meta.url)), "..", "node_modules", "@mercuryworkshop", "libcurl-transport", "dist");

const PORT = Number(process.env.RAMJET_PORT || 4204);
const HOST = process.env.RAMJET_HOST || "0.0.0.0";
const publicPath = fileURLToPath(new URL("../public/", import.meta.url));
const BLOCKLIST_FILE = join(DATA_DIR, "blocklist.txt");

logging.set_level(logging.NONE);
Object.assign(wisp.options, {
	allow_udp_streams: false,
	allow_loopback_ips: false,   // explicit: the proxy must never reach box-local services
	allow_private_ips: false,    // explicit: no RFC1918 destinations through wisp
	dns_servers: ["1.1.1.3", "1.0.0.3"],
});

// -- v0.4: server-side ad/tracker blocklist ----------------------------------
// One domain per line in blocklist.txt ("#" comments ok). A line matches the
// exact host or any subdomain. Applied as wisp's native hostname_blacklist so
// blocked connections never leave the box. Global toggle: config.adblock.
// NOTE (ZK): per-user adblock prefs live in the encrypted user blob, which the
// server cannot read by design - so this filter is global, not per-user.
let blocklistRegexes = [];
function loadBlocklist() {
	try {
		const lines = readFileSync(BLOCKLIST_FILE, "utf8").split("\n");
		blocklistRegexes = lines
			.map((l) => l.trim().toLowerCase())
			.filter((l) => l && !l.startsWith("#"))
			.map((d) => new RegExp("(^|\\.)" + d.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$", "i"));
		console.log("ramjet: blocklist loaded (" + blocklistRegexes.length + " entries)");
	} catch {
		blocklistRegexes = [];
		console.log("ramjet: no blocklist at " + BLOCKLIST_FILE + " (adblock inert)");
	}
}
function applyBlocklist() {
	wisp.options.hostname_blacklist = loadConfig().adblock && blocklistRegexes.length ? blocklistRegexes : null;
}
loadBlocklist();
applyBlocklist();

const searxHtmlCache = new Map();
const SEARX_CACHE_TTL_MS = 10 * 60 * 1000;
const SEARX_CACHE_MAX = 150;

// -- static ------------------------------------------------------------------
const mounts = [
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

// -- admin --------------------------------------------------------------------
function requireAdmin(req, res) {
	const sr = sessionRecord(req);
	if (!sr || !sr.user) { json(res, 401, { error: "no session" }); return null; }
	const acct = readAccounts()[sr.user];
	if (!acct || acct.role !== "admin") { json(res, 403, { error: "admin only" }); return null; }
	return sr;
}
async function handleAdmin(req, res, action) {
	const sr = requireAdmin(req, res);
	if (!sr) return;
	const accounts = readAccounts();
	if (action === "users") {
		const seen = readLastSeen();
		const list = Object.entries(accounts).map(([name, a]) => ({
			username: name, role: a.role, status: a.status, created: a.created, lastSeen: seen[name] || null, syncEnabled: !!a.syncEnabled,
		}));
		return json(res, 200, { ok: true, users: list, requireApproval: loadConfig().requireApproval, adblock: loadConfig().adblock });
	}
	const p = await bodyParams(req);
	if (action === "config") {
		const cfg = loadConfig(); // preserve fields the client did not send
		if (p && p.get("requireApproval") !== null) cfg.requireApproval = p.get("requireApproval") === "1";
		if (p && p.get("adblock") !== null) cfg.adblock = p.get("adblock") === "1";
		await writeJson(join(DATA_DIR, "config.json"), cfg);
		applyBlocklist();
		return json(res, 200, { ok: true, requireApproval: cfg.requireApproval, adblock: cfg.adblock });
	}
	if (action === "blocklist-reload") {
		loadBlocklist();
		applyBlocklist();
		return json(res, 200, { ok: true, entries: blocklistRegexes.length });
	}
	const username = (p && p.get("username") || "").toLowerCase();
	if (!accounts[username]) return json(res, 404, { error: "no such user" });
	if (username === sr.user) return json(res, 400, { error: "can't change your own account here" });
	if (action === "sync-toggle") { accounts[username].syncEnabled = !accounts[username].syncEnabled; await writeAccounts(accounts); return json(res, 200, { ok: true, syncEnabled: !!accounts[username].syncEnabled }); }
	if (action === "approve") accounts[username].status = "active";
	else if (action === "deny") accounts[username].status = "denied";
	else if (action === "remove") {
		delete accounts[username];
		await writeAccounts(accounts);
		return json(res, 200, { ok: true });
	} else return json(res, 404, { error: "unknown action" });
	await writeAccounts(accounts);
	json(res, 200, { ok: true });
}

const server = createServer(async (req, res) => {
	res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
	res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
	res.setHeader("X-Content-Type-Options", "nosniff");
	res.setHeader("Referrer-Policy", "no-referrer");
	res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
	try {
		const url = new URL(req.url, "http://x");
		const pathname = url.pathname;
		if (pathname === "/healthz") {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ ok: true, engine: "wk", transport: "wisp", uptime: Math.round(process.uptime()) }));
			return;
		}
		if (pathname === "/auth/login" && req.method === "POST") return await handleLogin(req, res);
		if (pathname === "/auth/signup" && req.method === "POST") return await handleSignup(req, res);
		if (pathname === "/auth/passwd" && req.method === "POST") return await handlePasswd(req, res);
		if (pathname === "/auth/sync" && (req.method === "GET" || req.method === "PUT" || req.method === "POST")) return await handleSync(req, res);
		if (pathname === "/auth/sync-storage" && (req.method === "GET" || req.method === "PUT" || req.method === "POST")) return await handleSync(req, res, true);
		if (pathname === "/auth/wipe-on-close" && req.method === "POST") return await handleWipeOnClose(req, res);
		if (pathname === "/auth/wipe-status" && req.method === "GET") return await handleWipeStatus(req, res);
		if (pathname === "/auth/addons" && req.method === "GET") return listAddons(req, res);
		if (pathname.startsWith("/api/") && await dispatchAddonApi(req, res, pathname, url)) return;
		if (pathname === "/auth/me") {
			const sr = sessionRecord(req);
			if (!sr || !sr.user) return json(res, 401, { error: "no session" });
			const acct = readAccounts()[sr.user];
			return json(res, 200, { ok: true, user: sr.user, role: acct ? acct.role : "user", syncEnabled: !!(acct && acct.syncEnabled) });
		}
		if (pathname.startsWith("/auth/admin/")) return await handleAdmin(req, res, pathname.slice("/auth/admin/".length));
		if (pathname === "/auth/sync-toggle" && req.method === "POST") {
			const sr = sessionRecord(req);
			if (!sr || !sr.user) return json(res, 401, { error: "no session" });
			const accounts = readAccounts();
			const acct = accounts[sr.user];
			if (!acct) return json(res, 404, { error: "no such user" });
			acct.syncEnabled = !acct.syncEnabled;
			await writeAccounts(accounts);
			return json(res, 200, { ok: true, syncEnabled: !!acct.syncEnabled });
		}
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
		if (pathname !== "/api/" && /^\/[a-z0-9-]+(?:\/|$)/.test(pathname) && await serveAddonStatic(req, res, pathname)) return;
		if (pathname === "/search") return await searchHandle(req, res);
		if (pathname === "/th") return searchThumb(req, res);
		if (pathname === "/searx" || pathname.startsWith("/searx/")) {
			// reverse proxy to the local searxng container - the session gate
			// above already ran, so only signed-in users reach this. frames
			// load these pages same-origin; root-absolute links get the /searx prefix.
			const upstreamPath = req.url.slice("/searx".length) || "/";
			// small in-memory cache for search/index HTML: repeat searches and
			// back/forward nav come back instantly. keyed by path + the user's
			// searxng preferences cookie so different prefs never share entries.
			const pref = /(?:^|;\s*)preferences=([^;]*)/.exec(req.headers.cookie || "");
			const cacheKey = upstreamPath + "|" + (pref ? pref[1] : "");
			const cacheable = req.method === "GET" && (upstreamPath === "/" || upstreamPath.startsWith("/search"));
			const sendSearxHtml = (body, type) => {
				const out = Buffer.from(body, "utf8");
				const h2 = { "content-type": type || "text/html; charset=utf-8", "cache-control": "private, no-cache", vary: "accept-encoding" };
				if (String(req.headers["accept-encoding"] || "").includes("gzip") && out.length > 1024) {
					h2["content-encoding"] = "gzip";
					res.writeHead(200, h2);
					res.end(gzipSync(out));
				} else {
					h2["content-length"] = out.length;
					res.writeHead(200, h2);
					res.end(out);
				}
			};
			if (cacheable) {
				const hit = searxHtmlCache.get(cacheKey);
				if (hit && Date.now() - hit.ts < SEARX_CACHE_TTL_MS) { sendSearxHtml(hit.body, hit.type); return; }
			}
			const headers = { ...req.headers, host: "127.0.0.1:8888" };
			delete headers["accept-encoding"];
			const u = httpRequest({ host: "127.0.0.1", port: 8888, path: upstreamPath, method: req.method, headers }, (ures) => {
				const h = { ...ures.headers };
				if (typeof h.location === "string" && h.location.startsWith("/") && !h.location.startsWith("/searx/")) h.location = "/searx" + h.location;
				const setCookie = h["set-cookie"];
				if (Array.isArray(setCookie)) h["set-cookie"] = setCookie.map((c) => c.replace(/;\s*[Pp]ath=\//, "; Path=/searx"));
				const type = String(h["content-type"] || "");
				if (ures.statusCode === 200 && type.includes("text/html")) {
					const chunks = [];
					ures.on("data", (c) => chunks.push(c));
					ures.on("end", () => {
						let body = Buffer.concat(chunks).toString("utf8");
						body = body.replace(/(\bhref|\bsrc|\baction)="\/(?!\/|searx\/)/g, '$1="/searx/');
						body = body.replace(/(url=)\/(?!\/|searx\/)/g, "$1/searx/");
						if (cacheable) {
							searxHtmlCache.set(cacheKey, { body, type, ts: Date.now() });
							if (searxHtmlCache.size > SEARX_CACHE_MAX) searxHtmlCache.delete(searxHtmlCache.keys().next().value);
						}
						sendSearxHtml(body, type);
					});
				} else {
					if (ures.statusCode === 200 && upstreamPath.startsWith("/static/")) h["cache-control"] = "public, max-age=86400";
					res.writeHead(ures.statusCode || 502, h);
					ures.pipe(res);
				}
			});
			u.on("error", () => {
				if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
				res.end("search is waking up - try again in a few seconds");
			});
			req.pipe(u);
			return;
		}
		const file = resolveFile(pathname);
		const st = await stat(file).catch(() => null);
		if (!st || !st.isFile()) {
			const page404 = await readFile(join(publicPath, "404.html")).catch(() => null);
			if (page404) {
				res.writeHead(404, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" });
				res.end(page404);
			} else {
				res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
				res.end("404 - lost in the pasture");
			}
			return;
		}
		const type = MIME[extname(file).toLowerCase()] || "application/octet-stream";
		// v0.11.x speed pass: weak etag + 304s so repeat visits through the
		// tunnel don't re-pull ~2MB of engine libs every boot. /lib/* is
		// vendored per release and app.js/style.css ship versioned ?v= URLs, so
		// an hour of reuse is safe; html + sw.js stay fresh-check-always.
		const etag = 'W/"' + st.size + "-" + Math.floor(st.mtimeMs) + '"';
		const isHtml = type.startsWith("text/html");
		const isSw = file.endsWith("sw.js");
		const cache = isHtml ? "no-cache, must-revalidate" : isSw ? "no-cache" : file.includes("/lib/") ? "public, max-age=3600" : "public, max-age=3600";
		if (req.headers["if-none-match"] === etag) {
			res.writeHead(304, { "cache-control": cache, etag });
			res.end();
			return;
		}
		const headers = { "content-type": type, "cache-control": cache, etag, vary: "accept-encoding" };
		if (isSw) headers["service-worker-allowed"] = "/";
		const compressible = /^(text\/|application\/(javascript|wasm|json|wasm))/.test(type) || type === "application/wasm";
		const body = await readFile(file);
		if (compressible && body.length > 1024 && String(req.headers["accept-encoding"] || "").includes("gzip")) {
			headers["content-encoding"] = "gzip";
			res.writeHead(200, headers);
			res.end(gzipSync(body));
		} else {
			headers["content-length"] = body.length;
			res.writeHead(200, headers);
			res.end(body);
		}
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
	console.log(`ramjet v1.1: listening on http://${hostname()}:${PORT} (bind ${HOST}:${PORT}, gate ${passwordArmed ? "armed" : "UNARMED"})`);
});
