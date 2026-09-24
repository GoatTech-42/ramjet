// Ramjet client - ignition logic. GoatTech, 2026. AGPL-3.0.
"use strict";

const { ScramjetController } = $scramjetLoadController();

const scramjet = new ScramjetController({
	files: {
		wasm: "/scram/scramjet.wasm.wasm",
		all: "/scram/scramjet.all.js",
		sync: "/scram/scramjet.sync.js",
	},
});
scramjet.init();

const connection = new BareMux.BareMuxConnection("/baremux/worker.js");

const form = document.getElementById("rj-form");
const address = document.getElementById("rj-address");
const statusEl = document.getElementById("rj-status");
const frameHost = document.getElementById("rj-framehost");
const landing = document.getElementById("rj-landing");
const bar = document.getElementById("rj-bar");

let frame = null;
let swReady = null;

function setStatus(msg, mode) {
	statusEl.textContent = msg;
	statusEl.dataset.mode = mode || "idle";
}

async function ensureReady() {
	if (!navigator.serviceWorker) {
		throw new Error("this browser has no service worker support");
	}
	if (!swReady) {
		setStatus("spooling up...", "busy");
		swReady = (async () => {
			await navigator.serviceWorker.register("/sw.js");
			const wispUrl =
				(location.protocol === "https:" ? "wss" : "ws") +
				"://" +
				location.host +
				"/wisp/";
			if ((await connection.getTransport()) !== "/libcurl/index.mjs") {
				await connection.setTransport("/libcurl/index.mjs", [
					{ websocket: wispUrl },
				]);
			}
		})();
	}
	return swReady;
}

// turns whatever was typed into a real url (or a search)
function resolveInput(raw) {
	const input = raw.trim();
	if (!input) return null;
	try {
		return new URL(input).toString();
	} catch (err) {}
	try {
		const url = new URL("http://" + input);
		if (url.hostname.includes(".")) return url.toString();
	} catch (err) {}
	return "https://duckduckgo.com/?q=" + encodeURIComponent(input);
}

function ignite(url) {
	if (!frame) {
		frame = scramjet.createFrame();
		frame.frame.id = "rj-frame";
		frame.frame.addEventListener("load", syncBar);
		frameHost.appendChild(frame.frame);
	}
	frame.go(url);
	document.body.classList.add("in-flight");
	setStatus("", "idle");
}

function syncBar() {
	if (!frame) return;
	try {
		const loc = frame.frame.contentWindow.location;
		address.value = loc.href === "about:blank" ? "" : loc.href;
	} catch (err) {}
}

form.addEventListener("submit", async (event) => {
	event.preventDefault();
	const url = resolveInput(address.value);
	if (!url) return;
	try {
		await ensureReady();
	} catch (err) {
		setStatus("engine failed to start: " + err.message, "error");
		return;
	}
	ignite(url);
});

document.getElementById("rj-back").addEventListener("click", () => {
	if (frame) frame.frame.contentWindow.history.back();
});
document.getElementById("rj-fwd").addEventListener("click", () => {
	if (frame) frame.frame.contentWindow.history.forward();
});
document.getElementById("rj-reload").addEventListener("click", () => {
	if (frame) frame.frame.contentWindow.location.reload();
});
document.getElementById("rj-home").addEventListener("click", () => {
	document.body.classList.remove("in-flight");
	address.value = "";
	address.focus();
});

// warm the engine in the background once the page is idle
if ("requestIdleCallback" in window) {
	requestIdleCallback(() => ensureReady().catch(() => {}), { timeout: 4000 });
}

setStatus("engine: scramjet 1.1.0 · transport: wisp · ready", "idle");
address.focus();
