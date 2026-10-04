// keeps the local search backend alive as a child of ramjet. localhost only.
// if searxng/venv is missing (fresh checkout) run searxng/setup.sh once.
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
const DIR = new URL("../searxng/", import.meta.url).pathname;
const DATA = process.env.RJ_DATA || new URL("../data/", import.meta.url).pathname;
const PORT = process.env.SEARX_PORT || "8888";
let child = null, stopping = false, fails = 0;
function secret() {
	const f = DATA + "/searxng-secret";
	try { return readFileSync(f, "utf8").trim(); } catch {}
	const s = randomBytes(24).toString("hex");
	try { writeFileSync(f, s, { mode: 0o600 }); } catch {}
	return s;
}
function start() {
	if (stopping) return;
	if (!existsSync(DIR + "venv/bin/python")) { console.log("[searxng] not installed - run searxng/setup.sh"); return; }
	const t0 = Date.now();
	child = spawn(DIR + "venv/bin/python", [DIR + "src/searx/webapp.py"], {
		env: { ...process.env, SEARXNG_SETTINGS_PATH: DIR + "settings.yml", SEARXNG_BIND_ADDRESS: "127.0.0.1", SEARXNG_PORT: PORT, SEARXNG_SECRET: secret() },
		stdio: ["ignore", "ignore", "ignore"],
	});
	child.on("exit", (code) => {
		child = null;
		if (stopping) return;
		fails = Date.now() - t0 < 20000 ? fails + 1 : 0;
		setTimeout(start, Math.min(60000, 2000 * (fails + 1)));
	});
}
export function startSearxng() { start(); }
export function stopSearxng() { stopping = true; try { child && child.kill("SIGTERM"); } catch {} }
