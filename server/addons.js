// Ramjet addon system (v1.1, Luke): addons are self-contained directories
// (usually their own repo) registered in ramjet-data/addons.json:
//   [{ "id": "jetstream", "name": "Jetstream", "entry": "/jetstream/",
//      "dir": "/home/luke/goattech/jetstream", "hasApi": true }]
// - GET /auth/addons lists [{id, name, entry}] for the home-page tiles.
// - /api/<id>/* dispatches to <dir>/server.js (default export
//   async (req, res, route, url, ctx) => true when handled; ctx = {user}).
// - /<id>/* serves static files from <dir>/public/ (session-gated by the
//   same global auth gate as everything else).
import { readFile, stat } from "node:fs/promises";
import { join, normalize, extname, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { DATA_DIR, readJson, json, MIME } from "./util.js";
import { sessionRecord } from "./auth.js";

const ADDONS_FILE = join(DATA_DIR, "addons.json");
const ID_OK = /^[a-z0-9-]+$/;
// ids that would shadow ramjet's own routes are rejected at load time
const RESERVED = new Set(["api", "auth", "search", "searx", "th", "login", "libcurl", "healthz", "assets", "favicon.ico", "sw.js", "rjcrypto.js"]);

let addons = [];
const handlers = new Map(); // id -> { dir, hasApi, mod: Promise<fn> }

export function loadAddons() {
	const raw = readJson(ADDONS_FILE, []);
	addons = [];
	handlers.clear();
	for (const a of Array.isArray(raw) ? raw : []) {
		if (!a || !ID_OK.test(a.id || "") || RESERVED.has(a.id) || typeof a.dir !== "string" || !a.dir.startsWith("/")) {
			console.error("ramjet: skipping bad addon entry", a && a.id);
			continue;
		}
		const pub = join(a.dir, "public");
		const rec = { id: a.id, name: String(a.name || a.id), entry: a.entry || "/" + a.id + "/", dir: a.dir, pub, hasApi: !!a.hasApi };
		addons.push({ id: rec.id, name: rec.name, entry: rec.entry });
		handlers.set(rec.id, rec);
	}
	console.log("ramjet: addons loaded (" + addons.map((a) => a.id).join(", ") + ")");
}
loadAddons();

export function listAddons(req, res) {
	const sr = sessionRecord(req);
	if (!sr || !sr.user) return json(res, 401, { error: "no session" });
	return json(res, 200, { ok: true, addons });
}

function apiHandler(rec) {
	if (!rec.mod) {
		rec.mod = import(pathToFileURL(join(rec.dir, "server.js")).href)
			.then((m) => (typeof m.default === "function" ? m.default : null))
			.catch((e) => { console.error("ramjet: addon '" + rec.id + "' failed to load:", e.message); return null; });
	}
	return rec.mod;
}

// matches /api/<id>/<route...> for a registered id with hasApi
export async function dispatchAddonApi(req, res, pathname, url) {
	const m = /^\/api\/([a-z0-9-]+)(?:\/(.*))?$/.exec(pathname);
	if (!m) return false;
	const rec = handlers.get(m[1]);
	if (!rec || !rec.hasApi) return false;
	const fn = await apiHandler(rec);
	if (!fn) { json(res, 502, { error: "addon unavailable" }); return true; }
	const sr = sessionRecord(req);
	const ctx = { user: sr && sr.user ? sr.user : null };
	await fn(req, res, m[2] || "", url, ctx);
	return true;
}

// serves /<id>/... from the addon's public/ dir; returns true when the path
// belongs to a registered addon (even on 404, so we never fall through to
// ramjet's own static handler with a foreign path).
export async function serveAddonStatic(req, res, pathname) {
	const m = /^\/([a-z0-9-]+)(?:\/(.*))?$/.exec(pathname);
	if (!m) return false;
	const rec = handlers.get(m[1]);
	if (!rec) return false;
	let rel;
	try { rel = decodeURIComponent(m[2] || ""); } catch { rel = ""; }
	if (!rel || rel.endsWith("/")) rel += "index.html";
	const clean = normalize(rel).replace(/^([/\\])+/, "").replace(/^(\.\.[/\\])+/, "");
	const file = join(rec.pub, clean);
	if (resolve(file) !== resolve(rec.pub) && !resolve(file).startsWith(resolve(rec.pub) + sep)) {
		res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
		res.end("nope");
		return true;
	}
	const st = await stat(file).catch(() => null);
	if (!st || !st.isFile()) {
		res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
		res.end("404 - " + rec.id + " has no such page");
		return true;
	}
	const type = MIME[extname(file).toLowerCase()] || "application/octet-stream";
	const body = await readFile(file);
	res.writeHead(200, { "content-type": type, "cache-control": type.startsWith("text/html") ? "no-cache, must-revalidate" : "public, max-age=3600" });
	res.end(body);
	return true;
}
