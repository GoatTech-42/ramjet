// Ramjet auth: password gate, accounts, sessions, encrypted sync, wipes. GoatTech, 2026. MIT.
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { DATA_DIR, readJson, writeJson, loadConfig, json, validUsername, clientIp, readBody, bodyParams } from "./util.js";

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
// History/bookmarks/settings are stored AES-256-GCM encrypted per user (the
// client holds the key - the server only stores the opaque blob).
const ACCOUNTS_FILE = join(DATA_DIR, "accounts.json");
const USERDATA_DIR = join(DATA_DIR, "userdata");

export function readAccounts() { return readJson(ACCOUNTS_FILE, {}); }
export async function writeAccounts(a) { await writeJson(ACCOUNTS_FILE, a); }

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

// -- v0.4: lastSeen + 7-day inactivity wipe ----------------------------------
const LASTSEEN_FILE = join(DATA_DIR, "lastseen.json");
export function readLastSeen() { return readJson(LASTSEEN_FILE, {}); }
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

// -- sessions -----------------------------------------------------------------
export function sessionRecord(req) {
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
export function sessionFrom(req) {
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
export async function killSession(req, res) {
	const token = sessionFrom(req);
	if (token) {
		const s = readJson(SESSIONS_FILE, {});
		delete s[token];
		await writeJson(SESSIONS_FILE, s);
	}
	res.setHeader("Set-Cookie", "rj_session=; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
}

const PUBLIC_PREFIXES = ["/login", "/auth/login", "/auth/signup", "/auth/logout", "/auth/me", "/rjcrypto.js", "/healthz", "/assets/", "/style.css", "/favicon", "/sw.js"];
export function isPublic(pathname) {
	return PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(p.endsWith("/") ? p : p + "?"));
}

// -- handlers -----------------------------------------------------------------
export async function handleLogin(req, res) {
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
	res.writeHead(303, { location: "/login?bad=1" });
	res.end();
}

export async function handleSignup(req, res) {
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

export async function handleSync(req, res, storage) {
	const sr = sessionRecord(req);
	if (!sr || !sr.user) return json(res, 401, { error: "no session" });
	if (storage) {
		const acct = readAccounts()[sr.user];
		if (!acct || acct.role !== "admin") return json(res, 403, { error: "admin only" });
	}
	const file = storage ? userDataFile(sr.user).replace(".blob.json", ".storage.json") : userDataFile(sr.user);
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

// v1.0.8 (Luke report): close-time wipe tombstone. The blobs are client-encrypted
// (AES-GCM), so the server cannot edit history inside them - instead it records
// the close, and the client (next open, new tab, or sibling tab) performs the
// actual wipe and pushes the empty state through the normal encrypted push.
const WIPE_TS_FILE = join(DATA_DIR, "wipe-ts.json");
const WIPE_LOG_FILE = join(DATA_DIR, "wipe-log.json");
async function drainBody(req) {
	try {
		req.resume();
		await new Promise((resolve) => { req.on("end", resolve); req.on("error", resolve); setTimeout(resolve, 2000); });
	} catch {}
}
export async function handleWipeOnClose(req, res) {
	await drainBody(req);
	const sr = sessionRecord(req);
	if (!sr || !sr.user) return json(res, 401, { error: "no session" });
	const at = Date.now();
	const ts = readJson(WIPE_TS_FILE, {});
	ts[sr.user] = at;
	await writeJson(WIPE_TS_FILE, ts);
	try {
		const log = readJson(WIPE_LOG_FILE, []);
		log.push({ user: sr.user, at });
		while (log.length > 200) log.shift();
		await writeJson(WIPE_LOG_FILE, log);
	} catch {}
	json(res, 200, { ok: true, wipeAt: at });
}
export async function handleWipeStatus(req, res) {
	const sr = sessionRecord(req);
	if (!sr || !sr.user) return json(res, 401, { error: "no session" });
	const ts = readJson(WIPE_TS_FILE, {});
	json(res, 200, { ok: true, wipeAt: ts[sr.user] || 0 });
}

export async function handlePasswd(req, res) {
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

export const passwordArmed = !!PASSWORD_HASH;
