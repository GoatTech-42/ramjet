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
import { fileURLToPath as _furl } from "node:url";
const libcurlPath = join(fileURLToPath(new URL(".", import.meta.url)), "..", "node_modules", "@mercuryworkshop", "libcurl-transport", "dist");
const controllerPath = join(fileURLToPath(new URL(".", import.meta.url)), "..", "node_modules", "@mercuryworkshop", "scramjet-controller", "dist");

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
const BLOB_MAX_BYTES = 256 * 1024;            // v0.4: hard cap per-user sync blob
const INACTIVITY_WIPE_MS = 7 * 24 * 3600 * 1000; // v0.4: wipe users idle 7+ days
const LASTSEEN_TOUCH_MS = 5 * 60 * 1000;      // throttle lastSeen writes
const SIGNUP_MAX_PER_HOUR = 5;                // v0.4: per-IP signup throttle
const BLOCKLIST_FILE = join(DATA_DIR, "blocklist.txt");

logging.set_level(logging.NONE);
Object.assign(wisp.options, {
	allow_udp_streams: false,
	allow_loopback_ips: false,   // explicit: the proxy must never reach box-local services
	allow_private_ips: false,    // explicit: no RFC1918 destinations through wisp
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

// -- accounts + encrypted per-user data ---------------------------------------
// History/bookmarks/settings are stored AES-256-GCM encrypted per user. The
// 32-byte data key is itself wrapped with a KEK derived from the user's
// password (scrypt), so the files on disk are useless without the password.
// Unwrapped keys live only in process memory, keyed by session token.
const ACCOUNTS_FILE = join(DATA_DIR, "accounts.json");
const CONFIG_FILE = join(DATA_DIR, "config.json");
const USERDATA_DIR = join(DATA_DIR, "userdata");

function loadConfig() {
	const c = readJson(CONFIG_FILE, null);
	if (c && typeof c === "object") return { requireApproval: c.requireApproval !== false, adblock: c.adblock !== false };
	return { requireApproval: true, adblock: true };
}

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
function readAccounts() { return readJson(ACCOUNTS_FILE, {}); }
async function writeAccounts(a) { await writeJson(ACCOUNTS_FILE, a); }

function hashPassword(pw) {
	const salt = randomBytes(16).toString("hex");
	return salt + "$" + scryptSync(pw, salt, 32).toString("hex");
}
function userDataFile(user) { return join(USERDATA_DIR, user.replace(/[^a-z0-9._-]/gi, "_") + ".blob.json"); }

// seed the admin account from the existing gate hash on first run; the data
// key gets wrapped lazily on luke's next successful password login.
(function migrateAccounts() {
	const accounts = readAccounts();
	if (Object.keys(accounts).length || !PASSWORD_HASH) return;
	const [salt, hash] = PASSWORD_HASH.split("$");
	accounts.luke = { salt, hash, role: "admin", status: "active", created: Date.now() };
	writeJson(ACCOUNTS_FILE, accounts);
	console.log("ramjet: seeded admin account 'luke' from gate password");
})();

function readJson(p, dflt) { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return dflt; } }
async function writeJson(p, v) { try { await writeFile(p, JSON.stringify(v), { mode: 0o600 }); } catch {} }

function sessionRecord(req) {
	const m = /(?:^|;\s*)rj_session=([0-9a-f]{64})/.exec(req.headers.cookie || "");
	if (!m) return null;
	const sessions = readJson(SESSIONS_FILE, {});
	let rec = sessions[m[1]];
	if (!rec) return null;
	if (typeof rec === "number") rec = { exp: rec, user: "luke" }; // legacy gate sessions belong to luke
	if (Date.now() > rec.exp) { delete sessions[m[1]]; writeJson(SESSIONS_FILE, sessions); return null; }
	if (rec.user) touchLastSeen(rec.user);
	return { token: m[1], user: rec.user || null };
}
function sessionFrom(req) {
	const r = sessionRecord(req);
	return r ? r.token : null;
}
async function newSession(res, user) {
	const token = randomBytes(32).toString("hex");
	const sessions = readJson(SESSIONS_FILE, {});
	sessions[token] = { exp: Date.now() + SESSION_TTL_MS, user: user || null };
	// prune expired
	for (const k of Object.keys(sessions)) {
		const r = sessions[k];
		const exp = typeof r === "number" ? r : r.exp;
		if (exp < Date.now()) delete sessions[k];
	}
	await writeJson(SESSIONS_FILE, sessions);
	res.setHeader("Set-Cookie", `rj_session=${token}; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`);
	return token;
}
async function killSession(req, res) {
	const token = sessionFrom(req);
	if (token) {
		const s = readJson(SESSIONS_FILE, {});
		delete s[token];
		await writeJson(SESSIONS_FILE, s);
	}
	res.setHeader("Set-Cookie", "rj_session=; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
}

// -- v0.4: lastSeen + 7-day inactivity wipe ----------------------------------
// Every authed request touch-refreshes the user's lastSeen (writes throttled
// to 5 min). A sweep at boot and every 24h wipes accounts idle 7+ days:
// account record, encrypted blob, and live sessions all go. Admins are exempt.
const LASTSEEN_FILE = join(DATA_DIR, "lastseen.json");
function touchLastSeen(user) {
	const seen = readJson(LASTSEEN_FILE, {});
	const now = Date.now();
	if (seen[user] && now - seen[user] < LASTSEEN_TOUCH_MS) return;
	seen[user] = now;
	writeJson(LASTSEEN_FILE, seen); // fire-and-forget; non-critical
}
async function wipeUser(username) {
	const accounts = readAccounts();
	delete accounts[username];
	await writeAccounts(accounts);
	const sessions = readJson(SESSIONS_FILE, {});
	let changed = false;
	for (const [tok, r] of Object.entries(sessions)) {
		if (r && typeof r === "object" && r.user === username) { delete sessions[tok]; changed = true; }
	}
	if (changed) await writeJson(SESSIONS_FILE, sessions);
	const seen = readJson(LASTSEEN_FILE, {});
	delete seen[username];
	await writeJson(LASTSEEN_FILE, seen);
	const { rm } = await import("node:fs/promises");
	await rm(userDataFile(username), { force: true }).catch(() => {});
	console.log("ramjet: wiped inactive user '" + username + "' (7d inactivity)");
}
async function inactivitySweep() {
	const now = Date.now();
	const seen = readJson(LASTSEEN_FILE, {});
	for (const [name, acct] of Object.entries(readAccounts())) {
		if (acct.role === "admin") continue;
		const ref = seen[name] || acct.created || 0;
		if (now - ref > INACTIVITY_WIPE_MS) await wipeUser(name);
	}
}
inactivitySweep().catch(() => {});
setInterval(() => inactivitySweep().catch(() => {}), 24 * 3600 * 1000).unref();

const PUBLIC_PREFIXES = ["/login", "/auth/login", "/auth/signup", "/auth/logout", "/auth/me", "/rjcrypto.js", "/healthz", "/assets/", "/style.css", "/favicon", "/sw.js"];
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
	{ prefix: "/scramjet/", root: scramjetPath },
	{ prefix: "/controller/", root: controllerPath },
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

function readBody(req, limit = 4096) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		req.on("data", (c) => {
			size += c.length;
			if (size > limit) { reject(new Error("body too big")); req.destroy(); return; }
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
		res.writeHead(303, { location: "/login?fresh=v070&locked=1" });
		res.end();
		return;
	}
	let pw = "", username = "";
	try {
		const body = await readBody(req);
		const params = new URLSearchParams(body);
		pw = params.get("password") || "";
		username = (params.get("username") || "").toLowerCase();
	} catch {}
	if (pw && username) {
		const handled = await handleLoginAccount(req, res, pw, username);
		if (handled) {
			guard[ip] = { fails: 0, locked_until: 0 };
			await writeJson(GUARD_FILE, guard);
			return;
		}
	}
	if (PASSWORD_HASH && !username && verifyPassword(pw, PASSWORD_HASH)) {
		{
			const accounts = readAccounts();
			const acct = accounts.luke;
			if (acct) {
				await newSession(res, "luke");
				guard[ip] = { fails: 0, locked_until: 0 };
				await writeJson(GUARD_FILE, guard);
				res.writeHead(303, { location: "/" });
				res.end();
				return;
			}
		}
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
	res.writeHead(303, { location: "/login?fresh=v070&bad=1" });
	res.end();
}

function json(res, code, obj) {
	res.writeHead(code, { "content-type": "application/json" });
	res.end(JSON.stringify(obj));
}
function validUsername(u) { return typeof u === "string" && /^[a-zA-Z0-9._-]{2,24}$/.test(u); }
async function bodyParams(req, limit) {
	try { return new URLSearchParams(await readBody(req, limit)); }
	catch { return null; }
}

async function handleSignup(req, res) {
	const ip = clientIp(req);
	const guard = readJson(GUARD_FILE, {});
	const g = guard[ip] || { fails: 0, locked_until: 0 };
	const now = Date.now();
	g.signups = (g.signups || []).filter((t) => now - t < 3600 * 1000);
	if (g.signups.length >= SIGNUP_MAX_PER_HOUR) {
		guard[ip] = g;
		await writeJson(GUARD_FILE, guard);
		return json(res, 429, { error: "too many signups from this network, try later" });
	}
	g.signups.push(now);
	guard[ip] = g;
	await writeJson(GUARD_FILE, guard);
	const p = await bodyParams(req);
	const username = (p && p.get("username") || "").toLowerCase();
	const pw = p && p.get("password") || "";
	if (!validUsername(username) || pw.length < 4) return json(res, 400, { error: "username 2-24 chars (letters, numbers, . _ -), password 4+ chars" });
	const accounts = readAccounts();
	if (accounts[username]) return json(res, 409, { error: "that name is taken" });
	const [salt, hash] = hashPassword(pw).split("$");
	const needApproval = loadConfig().requireApproval;
	accounts[username] = {
		salt, hash, role: "user", created: Date.now(),
		status: needApproval ? "pending" : "active",
	};
	await writeAccounts(accounts);
	if (needApproval) return json(res, 200, { ok: true, pending: true });
	await newSession(res, username);
	json(res, 200, { ok: true, pending: false });
}

async function handleLoginAccount(req, res, pw, username) {
	// returns true if handled as an account login
	const accounts = readAccounts();
	const acct = accounts[username];
	if (!acct) return false;
	if (!verifyPassword(pw, acct.salt + "$" + acct.hash)) return false;
	if (acct.status === "pending") { json(res, 403, { error: "account pending approval" }); return true; }
	if (acct.status !== "active") { json(res, 403, { error: "account disabled" }); return true; }
	await newSession(res, username);
	json(res, 200, { ok: true, redirect: "/" });
	return true;
}


async function handleSync(req, res) {
	const sr = sessionRecord(req);
	if (!sr || !sr.user) return json(res, 401, { error: "no session" });
	const file = userDataFile(sr.user);
	if (req.method === "GET") {
		return json(res, 200, { ok: true, blob: readJson(file, null) });
	}
	const p = await bodyParams(req, 512 * 1024);
	if (!p) return json(res, 400, { error: "bad body" });
	const blob = p.get("blob");
	if (blob === null) return json(res, 400, { error: "missing blob" });
	if (blob.length > BLOB_MAX_BYTES) return json(res, 413, { error: "blob too large (256KB max)" });
	let parsed;
	try { parsed = JSON.parse(blob); } catch { return json(res, 400, { error: "blob must be JSON" }); }
	await mkdir(USERDATA_DIR, { recursive: true }).catch(() => {});
	await writeJson(file, parsed);
	json(res, 200, { ok: true });
}

async function handlePasswd(req, res) {
	const sr = sessionRecord(req);
	if (!sr || !sr.user) return json(res, 401, { error: "no session" });
	const p = await bodyParams(req);
	const oldPw = p && p.get("old") || "";
	const newPw = p && p.get("new") || "";
	if (newPw.length < 4) return json(res, 400, { error: "password 4+ chars" });
	const accounts = readAccounts();
	const acct = accounts[sr.user];
	if (!acct || !verifyPassword(oldPw, acct.salt + "$" + acct.hash)) return json(res, 403, { error: "current password wrong" });
	const [salt, hash] = hashPassword(newPw).split("$");
	acct.salt = salt;
	acct.hash = hash;
	await writeAccounts(accounts);
	json(res, 200, { ok: true });
}

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
		const seen = readJson(LASTSEEN_FILE, {});
		const list = Object.entries(accounts).map(([name, a]) => ({
			username: name, role: a.role, status: a.status, created: a.created, lastSeen: seen[name] || null,
		}));
		return json(res, 200, { ok: true, users: list, requireApproval: loadConfig().requireApproval, adblock: loadConfig().adblock });
	}
	const p = await bodyParams(req);
	if (action === "config") {
		const cfg = loadConfig(); // preserve fields the client did not send
		if (p && p.get("requireApproval") !== null) cfg.requireApproval = p.get("requireApproval") === "1";
		if (p && p.get("adblock") !== null) cfg.adblock = p.get("adblock") === "1";
		await writeJson(CONFIG_FILE, cfg);
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
		if (pathname === "/login" && !url.searchParams.has("fresh")) { res.writeHead(302, { location: "/login?fresh=v070" }); res.end(); return; }
		if (pathname === "/healthz") {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ ok: true, engine: "scramjet", transport: "wisp", uptime: Math.round(process.uptime()) }));
			return;
		}
		if (pathname === "/auth/login" && req.method === "POST") return await handleLogin(req, res);
		if (pathname === "/auth/signup" && req.method === "POST") return await handleSignup(req, res);
		if (pathname === "/auth/passwd" && req.method === "POST") return await handlePasswd(req, res);
		if (pathname === "/auth/sync" && (req.method === "GET" || req.method === "PUT" || req.method === "POST")) return await handleSync(req, res);
		if (pathname === "/auth/me") {
			const sr = sessionRecord(req);
			if (!sr || !sr.user) return json(res, 401, { error: "no session" });
			const acct = readAccounts()[sr.user];
			return json(res, 200, { ok: true, user: sr.user, role: acct ? acct.role : "user" });
		}
		if (pathname.startsWith("/auth/admin/")) return await handleAdmin(req, res, pathname.slice("/auth/admin/".length));
		if (pathname === "/auth/logout") {
			await killSession(req, res);
			res.writeHead(303, { location: "/login?fresh=v070" });
			res.end();
			return;
		}
		if (!isPublic(pathname) && !sessionFrom(req)) {
			if (req.method === "GET" || req.method === "HEAD") {
				res.writeHead(303, { location: "/login?fresh=v070" });
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
		const headers = { "content-type": type, "content-length": st.size, "cache-control": type.startsWith("text/html") ? "no-store" : "no-cache" };
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
