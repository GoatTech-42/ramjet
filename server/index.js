// Ramjet server - static UI + wisp transport on one port, password-gated.
// GoatTech, 2026. MIT.
import { createServer } from "node:http";
import { readFile, stat, writeFile, mkdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join, normalize, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { hostname } from "node:os";
import { randomBytes, scryptSync, timingSafeEqual, createCipheriv, createDecipheriv } from "node:crypto";
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

// -- accounts + encrypted per-user data ---------------------------------------
// History/bookmarks/settings are stored AES-256-GCM encrypted per user. The
// 32-byte data key is itself wrapped with a KEK derived from the user's
// password (scrypt), so the files on disk are useless without the password.
// Unwrapped keys live only in process memory, keyed by session token.
const ACCOUNTS_FILE = join(DATA_DIR, "accounts.json");
const CONFIG_FILE = join(DATA_DIR, "config.json");
const USERDATA_DIR = join(DATA_DIR, "userdata");
const keyRing = new Map(); // token -> Buffer (32B data key), memory only

function loadConfig() {
	const c = readJson(CONFIG_FILE, null);
	if (c && typeof c === "object") return { requireApproval: c.requireApproval !== false };
	return { requireApproval: true };
}
function readAccounts() { return readJson(ACCOUNTS_FILE, {}); }
async function writeAccounts(a) { await writeJson(ACCOUNTS_FILE, a); }

function hashPassword(pw) {
	const salt = randomBytes(16).toString("hex");
	return salt + "$" + scryptSync(pw, salt, 32).toString("hex");
}
function wrapDataKey(key, pw) {
	const keySalt = randomBytes(16).toString("hex");
	const kek = scryptSync(pw, keySalt, 32);
	const iv = randomBytes(12);
	const c = createCipheriv("aes-256-gcm", kek, iv);
	const ct = Buffer.concat([c.update(key), c.final()]);
	return {
		keySalt,
		wrappedKey: iv.toString("hex") + "$" + c.getAuthTag().toString("hex") + "$" + ct.toString("hex"),
	};
}
function makeWrappedKey(pw) {
	const key = randomBytes(32);
	return { ...wrapDataKey(key, pw), key };
}
function unwrapKey(account, pw) {
	if (!account.wrappedKey || !account.keySalt) return null;
	const parts = account.wrappedKey.split("$");
	if (parts.length !== 3) return null;
	try {
		const kek = scryptSync(pw, account.keySalt, 32);
		const d = createDecipheriv("aes-256-gcm", kek, Buffer.from(parts[0], "hex"));
		d.setAuthTag(Buffer.from(parts[1], "hex"));
		return Buffer.concat([d.update(Buffer.from(parts[2], "hex")), d.final()]);
	} catch { return null; }
}
function cryptData(key, obj) {
	const iv = randomBytes(12);
	const c = createCipheriv("aes-256-gcm", key, iv);
	const ct = Buffer.concat([c.update(JSON.stringify(obj), "utf8"), c.final()]);
	return { iv: iv.toString("hex"), tag: c.getAuthTag().toString("hex"), ct: ct.toString("hex") };
}
function decryptData(key, blob) {
	try {
		const d = createDecipheriv("aes-256-gcm", key, Buffer.from(blob.iv, "hex"));
		d.setAuthTag(Buffer.from(blob.tag, "hex"));
		return JSON.parse(Buffer.concat([d.update(Buffer.from(blob.ct, "hex")), d.final()]).toString("utf8"));
	} catch { return null; }
}
const EMPTY_DATA = { history: [], bookmarks: [], settings: {} };
function userDataFile(user) { return join(USERDATA_DIR, user.replace(/[^a-z0-9._-]/gi, "_") + ".enc.json"); }
function readUserData(key, user) {
	const blob = readJson(userDataFile(user), null);
	if (!blob) return { ...EMPTY_DATA };
	return decryptData(key, blob) || { ...EMPTY_DATA };
}
async function writeUserData(key, user, data) {
	await mkdir(USERDATA_DIR, { recursive: true }).catch(() => {});
	await writeJson(userDataFile(user), cryptData(key, data));
}

// seed the admin account from the existing gate hash on first run; the data
// key gets wrapped lazily on luke's next successful password login.
(function migrateAccounts() {
	const accounts = readAccounts();
	if (Object.keys(accounts).length || !PASSWORD_HASH) return;
	const [salt, hash] = PASSWORD_HASH.split("$");
	accounts.luke = {
		salt, hash, role: "admin", status: "active", created: Date.now(),
		keySalt: null, wrappedKey: null,
	};
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
		keyRing.delete(token);
	}
	res.setHeader("Set-Cookie", "rj_session=; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
}

const PUBLIC_PREFIXES = ["/login", "/auth/login", "/auth/signup", "/auth/logout", "/auth/me", "/healthz", "/assets/", "/style.css", "/favicon"];
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
		res.writeHead(303, { location: "/login?locked=1" });
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
				const key = await loginKey(accounts, acct, pw);
				const token = await newSession(res, "luke");
				keyRing.set(token, key);
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
	res.writeHead(303, { location: "/login?bad=1" });
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
	const p = await bodyParams(req);
	const username = (p && p.get("username") || "").toLowerCase();
	const pw = p && p.get("password") || "";
	if (!validUsername(username) || pw.length < 4) return json(res, 400, { error: "username 2-24 chars (letters, numbers, . _ -), password 4+ chars" });
	const accounts = readAccounts();
	if (accounts[username]) return json(res, 409, { error: "that name is taken" });
	const [salt, hash] = hashPassword(pw).split("$");
	const { keySalt, wrappedKey } = makeWrappedKey(pw);
	const needApproval = loadConfig().requireApproval;
	accounts[username] = {
		salt, hash, role: "user", created: Date.now(),
		status: needApproval ? "pending" : "active",
		keySalt, wrappedKey,
	};
	await writeAccounts(accounts);
	if (needApproval) return json(res, 200, { ok: true, pending: true });
	await newSession(res, username);
	json(res, 200, { ok: true, pending: false });
}

async function loginKey(accounts, acct, pw) {
	let key = acct.wrappedKey ? unwrapKey(acct, pw) : null;
	if (!key) {
		const w = makeWrappedKey(pw);
		acct.keySalt = w.keySalt;
		acct.wrappedKey = w.wrappedKey;
		await writeAccounts(accounts);
		key = w.key;
	}
	return key;
}
async function handleLoginAccount(req, res, pw, username) {
	// returns true if handled as an account login
	const accounts = readAccounts();
	const acct = accounts[username];
	if (!acct) return false;
	if (!verifyPassword(pw, acct.salt + "$" + acct.hash)) return false;
	if (acct.status === "pending") { json(res, 403, { error: "account pending approval" }); return true; }
	if (acct.status !== "active") { json(res, 403, { error: "account disabled" }); return true; }
	const key = await loginKey(accounts, acct, pw);
	const token = await newSession(res, username);
	keyRing.set(token, key);
	json(res, 200, { ok: true, redirect: "/" });
	return true;
}

async function handleUnlock(req, res) {
	const sr = sessionRecord(req);
	if (!sr || !sr.user) return json(res, 401, { error: "no session" });
	const p = await bodyParams(req);
	const pw = p && p.get("password") || "";
	const accounts = readAccounts();
	const acct = accounts[sr.user];
	if (!acct || !verifyPassword(pw, acct.salt + "$" + acct.hash)) return json(res, 403, { error: "wrong password" });
	let key = acct.wrappedKey ? unwrapKey(acct, pw) : null;
	if (!key) {
		const w = makeWrappedKey(pw);
		acct.keySalt = w.keySalt;
		acct.wrappedKey = w.wrappedKey;
		await writeAccounts(accounts);
		key = w.key;
	}
	keyRing.set(sr.token, key);
	json(res, 200, { ok: true });
}

async function handleSync(req, res) {
	const sr = sessionRecord(req);
	if (!sr || !sr.user) return json(res, 401, { error: "no session" });
	const key = keyRing.get(sr.token);
	if (!key) return json(res, 401, { error: "reauth" });
	if (req.method === "GET") {
		return json(res, 200, { ok: true, data: readUserData(key, sr.user) });
	}
	const p = await bodyParams(req, 512 * 1024);
	if (!p) return json(res, 400, { error: "bad body" });
	const data = readUserData(key, sr.user);
	for (const field of ["history", "bookmarks"]) {
		const raw = p.get(field);
		if (raw !== null) {
			try { data[field] = JSON.parse(raw).slice(0, field === "history" ? 200 : 100); } catch {}
		}
	}
	const sraw = p.get("settings");
	if (sraw !== null) { try { data.settings = JSON.parse(sraw); } catch {} }
	await writeUserData(key, sr.user, data);
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
	let key = keyRing.get(sr.token) || unwrapKey(acct, oldPw);
	if (!key) key = randomBytes(32); // no prior key existed on disk
	const w = wrapDataKey(key, newPw);
	acct.salt = salt;
	acct.hash = hash;
	acct.keySalt = w.keySalt;
	acct.wrappedKey = w.wrappedKey;
	await writeAccounts(accounts);
	keyRing.set(sr.token, key);
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
		const list = Object.entries(accounts).map(([name, a]) => ({
			username: name, role: a.role, status: a.status, created: a.created,
		}));
		return json(res, 200, { ok: true, users: list, requireApproval: loadConfig().requireApproval });
	}
	const p = await bodyParams(req);
	if (action === "config") {
		const cfg = { requireApproval: (p && p.get("requireApproval")) === "1" };
		await writeJson(CONFIG_FILE, cfg);
		return json(res, 200, { ok: true, requireApproval: cfg.requireApproval });
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
	try {
		const url = new URL(req.url, "http://x");
		const pathname = url.pathname;
		if (pathname === "/healthz") {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ ok: true, engine: "scramjet", transport: "wisp", uptime: Math.round(process.uptime()) }));
			return;
		}
		if (pathname === "/auth/login" && req.method === "POST") return await handleLogin(req, res);
		if (pathname === "/auth/signup" && req.method === "POST") return await handleSignup(req, res);
		if (pathname === "/auth/unlock" && req.method === "POST") return await handleUnlock(req, res);
		if (pathname === "/auth/passwd" && req.method === "POST") return await handlePasswd(req, res);
		if (pathname === "/auth/sync" && (req.method === "GET" || req.method === "PUT" || req.method === "POST")) return await handleSync(req, res);
		if (pathname === "/auth/me") {
			const sr = sessionRecord(req);
			if (!sr || !sr.user) return json(res, 401, { error: "no session" });
			const acct = readAccounts()[sr.user];
			return json(res, 200, { ok: true, user: sr.user, role: acct ? acct.role : "user", unlocked: keyRing.has(sr.token) });
		}
		if (pathname.startsWith("/auth/admin/")) return await handleAdmin(req, res, pathname.slice("/auth/admin/".length));
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
