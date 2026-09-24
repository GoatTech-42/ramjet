// Ramjet client - ignition logic + settings, bookmarks, cloak, panic. GoatTech, 2026. MIT.
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
const starBtn = document.getElementById("rj-star");
const cloakBtn = document.getElementById("rj-cloak");

let frame = null;
let swReady = null;

// -- persisted settings ------------------------------------------------------
const SETTINGS_KEY = "rj.settings";
const BOOKMARKS_KEY = "rj.bookmarks";

const DEFAULTS = {
	theme: "amber",
	engine: "ddg",
	cloak: "off",
	panicKey: "`",
	panicUrl: "https://www.google.com",
};

let settings = { ...DEFAULTS };
try { Object.assign(settings, JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}")); } catch (err) {}
function saveSettings() { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); }

let bookmarks = [];
try { bookmarks = JSON.parse(localStorage.getItem(BOOKMARKS_KEY) || "[]"); } catch (err) {}
function saveBookmarks() { localStorage.setItem(BOOKMARKS_KEY, JSON.stringify(bookmarks)); }

const THEMES = {
	amber:  ["#ffa028", "#c96f04"],
	mint:   ["#34d399", "#059669"],
	sky:    ["#38bdf8", "#0369a1"],
	violet: ["#a78bfa", "#6d28d9"],
	ember:  ["#f87171", "#b91c1c"],
};

const ENGINES = {
	ddg:    ["DuckDuckGo", "https://duckduckgo.com/?q="],
	google: ["Google", "https://www.google.com/search?q="],
	bing:   ["Bing", "https://www.bing.com/search?q="],
	brave:  ["Brave", "https://search.brave.com/search?q="],
};

// cloak presets: title + tiny inline favicon
const CLOAK_ICON = {
	docs: "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" rx="2" fill="#fff"/><path d="M4 2h6l3 3v9H4z" fill="#4285f4"/><path d="M6 7h5M6 9.5h5M6 12h3.5" stroke="#fff" stroke-width="1.1"/></svg>'),
	classroom: "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" rx="2" fill="#0f9d58"/><circle cx="8" cy="5.5" r="2" fill="#fff"/><path d="M3.5 13c.6-2.6 2.4-4 4.5-4s3.9 1.4 4.5 4z" fill="#fff"/></svg>'),
	gmail: "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" rx="2" fill="#fff"/><path d="M2.5 4.5 8 9l5.5-4.5v7.5h-11z" fill="#ea4335"/><path d="M2.5 4.5 8 9l5.5-4.5" stroke="#fff" stroke-width="1" fill="none"/></svg>'),
	wiki: "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" rx="2" fill="#fff"/><text x="8" y="12.5" font-family="Georgia,serif" font-size="11" font-weight="bold" text-anchor="middle" fill="#333">W</text></svg>'),
};
const CLOAKS = {
	off: ["Ramjet - GoatTech", "/assets/ramjet.svg"],
	docs: ["Google Docs", CLOAK_ICON.docs],
	classroom: ["Google Classroom", CLOAK_ICON.classroom],
	gmail: ["Inbox (3) - Gmail", CLOAK_ICON.gmail],
	wiki: ["Wikipedia", CLOAK_ICON.wiki],
};

function applyTheme() {
	const [amber, deep] = THEMES[settings.theme] || THEMES.amber;
	document.documentElement.style.setProperty("--amber", amber);
	document.documentElement.style.setProperty("--amber-deep", deep);
}

function applyCloak() {
	const [title, icon] = CLOAKS[settings.cloak] || CLOAKS.off;
	document.title = title;
	let link = document.querySelector('link[rel="icon"]');
	if (!link) {
		link = document.createElement("link");
		link.rel = "icon";
		document.head.appendChild(link);
	}
	link.href = icon;
}

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
	const eng = ENGINES[settings.engine] || ENGINES.ddg;
	return eng[1] + encodeURIComponent(input);
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
		const href = loc.href;
		if (href === "about:blank") {
			address.value = "";
			return;
		}
		// show the real destination, not our encoded proxy path
		const prefix = location.origin + "/scramjet/";
		address.value = href.startsWith(prefix)
			? decodeURIComponent(href.slice(prefix.length))
			: href;
		syncStar();
	} catch (err) {}
}

// -- bookmarks ---------------------------------------------------------------
function currentUrl() {
	const v = address.value.trim();
	return v && v.includes(".") ? v : null;
}
function isBookmarked(url) {
	return bookmarks.some((b) => b.url === url);
}
function syncStar() {
	const url = currentUrl();
	starBtn.classList.toggle("starred", !!url && isBookmarked(url));
	starBtn.title = url && isBookmarked(url) ? "Bookmarked" : "Bookmark this page";
}
starBtn.addEventListener("click", () => {
	const url = currentUrl();
	if (!url) return;
	if (isBookmarked(url)) {
		bookmarks = bookmarks.filter((b) => b.url !== url);
	} else {
		bookmarks.unshift({ url, ts: Date.now() });
		bookmarks = bookmarks.slice(0, 50);
	}
	saveBookmarks();
	syncStar();
	renderBookmarks();
});
function renderBookmarks() {
	const list = document.getElementById("rj-bookmarks");
	list.innerHTML = "";
	if (!bookmarks.length) {
		const li = document.createElement("li");
		li.className = "rj-bm-empty";
		li.textContent = "no bookmarks yet - star a page while flying";
		list.appendChild(li);
		return;
	}
	for (const b of bookmarks) {
		const li = document.createElement("li");
		let host = b.url;
		try { host = new URL(b.url).hostname; } catch (err) {}
		const open = document.createElement("button");
		open.type = "button";
		open.className = "rj-bm-open";
		open.textContent = host;
		open.title = b.url;
		open.addEventListener("click", () => {
			closeSettings();
			ignite(b.url);
		});
		const del = document.createElement("button");
		del.type = "button";
		del.className = "rj-bm-del";
		del.textContent = "\u00d7";
		del.title = "Remove";
		del.addEventListener("click", () => {
			bookmarks = bookmarks.filter((x) => x.url !== b.url);
			saveBookmarks();
			syncStar();
			renderBookmarks();
		});
		li.append(open, del);
		list.appendChild(li);
	}
}

// -- settings panel ----------------------------------------------------------
const panel = document.getElementById("rj-panel");
function openSettings() {
	renderBookmarks();
	panel.hidden = false;
}
function closeSettings() {
	panel.hidden = true;
}
document.getElementById("rj-gear").addEventListener("click", openSettings);
document.getElementById("rj-panel-close").addEventListener("click", closeSettings);
panel.addEventListener("click", (e) => { if (e.target === panel) closeSettings(); });

// theme buttons
for (const btn of document.querySelectorAll("#rj-themes button")) {
	btn.addEventListener("click", () => {
		settings.theme = btn.dataset.theme;
		saveSettings();
		applyTheme();
		syncSettingsUI();
	});
}
// engine select
const engineSel = document.getElementById("rj-engine");
engineSel.addEventListener("change", () => {
	settings.engine = engineSel.value;
	saveSettings();
});
// cloak select + quick button
const cloakSel = document.getElementById("rj-cloak-sel");
cloakSel.addEventListener("change", () => {
	settings.cloak = cloakSel.value;
	saveSettings();
	applyCloak();
	syncSettingsUI();
});
cloakBtn.addEventListener("click", () => {
	settings.cloak = settings.cloak === "off" ? "docs" : "off";
	saveSettings();
	applyCloak();
	syncSettingsUI();
});
// panic config
const panicKeySel = document.getElementById("rj-panic-key");
const panicUrlIn = document.getElementById("rj-panic-url");
panicKeySel.addEventListener("change", () => {
	settings.panicKey = panicKeySel.value;
	saveSettings();
});
panicUrlIn.addEventListener("change", () => {
	settings.panicUrl = panicUrlIn.value.trim() || DEFAULTS.panicUrl;
	panicUrlIn.value = settings.panicUrl;
	saveSettings();
});
function syncSettingsUI() {
	for (const btn of document.querySelectorAll("#rj-themes button")) {
		btn.classList.toggle("active", btn.dataset.theme === settings.theme);
	}
	engineSel.value = settings.engine;
	cloakSel.value = settings.cloak;
	panicKeySel.value = settings.panicKey;
	panicUrlIn.value = settings.panicUrl;
	cloakBtn.classList.toggle("cloaked", settings.cloak !== "off");
}

// -- shortcuts + panic --------------------------------------------------------
document.addEventListener("keydown", (e) => {
	if (e.key === settings.panicKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
		window.location.replace(settings.panicUrl || DEFAULTS.panicUrl);
		return;
	}
	if (e.key === "Escape" && !panel.hidden) { closeSettings(); return; }
	const typing = document.activeElement === address || document.activeElement === panicUrlIn;
	if (typing) return;
	if (e.key === "/" || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k")) {
		e.preventDefault();
		address.focus();
		address.select();
	}
});

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

applyTheme();
applyCloak();
syncSettingsUI();
setStatus("engine: scramjet 1.1.0 \u00b7 transport: wisp \u00b7 ready", "idle");
address.focus();
