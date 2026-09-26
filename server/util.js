// Ramjet shared helpers. GoatTech, 2026. MIT.
import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

export const DATA_DIR = process.env.RAMJET_DATA_DIR || "/home/luke/goattech/ramjet-data";
export const CONFIG_FILE = join(DATA_DIR, "config.json");

export function readJson(p, dflt) { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return dflt; } }
export async function writeJson(p, v) { try { await writeFile(p, JSON.stringify(v), { mode: 0o600 }); } catch {} }

export function loadConfig() {
	const c = readJson(CONFIG_FILE, null);
	if (c && typeof c === "object") return { requireApproval: c.requireApproval !== false, adblock: c.adblock !== false };
	return { requireApproval: true, adblock: true };
}

export function json(res, code, obj) {
	res.writeHead(code, { "content-type": "application/json" });
	res.end(JSON.stringify(obj));
}
export function validUsername(u) { return typeof u === "string" && /^[a-zA-Z0-9._-]{2,24}$/.test(u); }
export function clientIp(req) {
	return (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "unknown";
}
export function readBody(req, limit = 4096) {
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
export async function bodyParams(req, limit) {
	try { return new URLSearchParams(await readBody(req, limit)); }
	catch { return null; }
}

export const MIME = {
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
