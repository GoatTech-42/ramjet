// Ramjet client - ignition logic + settings, bookmarks, history, cloak, panic. GoatTech, 2026. MIT.
"use strict";

// Scramjet v2: controller + transport are created in ensureReady() once the
// routing service worker controls the page.
let scramjet = null; // { createFrame } shim over the v2 Controller

const form = document.getElementById("rj-form");
const address = document.getElementById("rj-address");
const statusEl = document.getElementById("rj-status");
const frameHost = document.getElementById("rj-framehost");
const starBtn = document.getElementById("rj-star");
const cloakBtn = document.getElementById("rj-cloak");

let swReady = null;

// -- tabs ---------------------------------------------------------------------
const tablist = document.getElementById("rj-tablist");
let tabs = [];
let activeTab = null;
let tabSeq = 0;

function renderTabs() {
	document.body.classList.toggle("has-tabs", tabs.length > 0);
	tablist.innerHTML = "";
	try {
		localStorage.setItem(TABS_KEY, JSON.stringify({
			active: tabs.indexOf(activeTab),
			tabs: tabs.map((t) => ({ url: t.url, title: t.title, page: t.page || null, icon: t.icon || null })),
		}));
	} catch (err) {}
	for (const tab of tabs) {
		const el = document.createElement("div");
		el.className = "rj-tab" + (tab === activeTab ? " active" : "");
		el.title = tab.page ? tab.page : (tab.url || "new tab");
		if (tab.icon) {
			const icon = document.createElement("img");
			icon.className = "rj-tab-icon";
			icon.src = tab.icon;
			icon.alt = "";
			icon.draggable = false;
			icon.addEventListener("error", () => { if (tab.icon) { tab.icon = null; renderTabs(); } });
			el.appendChild(icon);
		} else {
			const tile = document.createElement("span");
			tile.className = "rj-tab-tile";
			tile.textContent = ((tab.page || tab.title || "n").trim()[0] || "n").toUpperCase();
			el.appendChild(tile);
		}
		el.draggable = true;
		el.addEventListener("dragstart", (e) => {
			e.dataTransfer.setData("text/rj-tab", String(tabs.indexOf(tab)));
			e.dataTransfer.effectAllowed = "move";
		});
		el.addEventListener("dragover", (e) => {
			if (!e.dataTransfer.types.includes("text/rj-tab")) return;
			e.preventDefault();
			e.dataTransfer.dropEffect = "move";
			el.classList.add("rj-drop");
		});
		el.addEventListener("dragleave", () => el.classList.remove("rj-drop"));
		el.addEventListener("drop", (e) => {
			el.classList.remove("rj-drop");
			const from = Number(e.dataTransfer.getData("text/rj-tab"));
			if (!Number.isInteger(from)) return;
			e.preventDefault();
			const to = tabs.indexOf(tab);
			if (from < 0 || from === to) return;
			const [moved] = tabs.splice(from, 1);
			tabs.splice(to, 0, moved);
			renderTabs();
		});
		el.addEventListener("auxclick", (e) => {
			if (e.button === 1) { e.preventDefault(); e.stopPropagation(); closeTab(tab); }
		});
		const label = document.createElement("span");
		label.className = "rj-tab-label";
		label.textContent = tab.page || tab.title || "new tab";
		const close = document.createElement("button");
		close.type = "button";
		close.className = "rj-tab-close";
		close.textContent = "\u00d7";
		close.title = "Close tab";
		close.addEventListener("click", (e) => { e.stopPropagation(); closeTab(tab); });
		el.append(label, close);
		el.addEventListener("click", () => activateTab(tab));
		el.addEventListener("contextmenu", (e) => {
			e.preventDefault();
			openTabMenu(e.clientX, e.clientY, tab);
		});
		tablist.appendChild(el);
	}
	const add = document.createElement("button");
	add.type = "button";
	add.id = "rj-newtab";
	add.title = "New tab";
	add.textContent = "+";
	add.addEventListener("click", () => newTab());
	tablist.appendChild(add);
	const badge = document.getElementById("rj-tabcount");
	if (badge) badge.textContent = String(tabs.length);
}

// -- mobile tab switcher (card grid) --
function openSwitcher() {
	const sw = document.getElementById("rj-switcher");
	const grid = document.getElementById("rj-switcher-grid");
	grid.textContent = "";
	for (const tab of tabs) {
		const card = document.createElement("div");
		card.className = "rj-card" + (tab === activeTab ? " active" : "");
		const body = document.createElement("button");
		body.type = "button";
		body.className = "rj-card-body";
		if (tab.icon) {
			const icon = document.createElement("img");
			icon.src = tab.icon;
			icon.alt = "";
			body.appendChild(icon);
		}
		const label = document.createElement("span");
		label.textContent = tab.page || tab.title || "new tab";
		body.appendChild(label);
		body.addEventListener("click", () => { activateTab(tab); closeSwitcher(); });
		const close = document.createElement("button");
		close.type = "button";
		close.className = "rj-card-close";
		close.textContent = "\u00d7";
		close.title = "Close tab";
		close.addEventListener("click", (e) => { e.stopPropagation(); closeTab(tab); if (!tabs.length) closeSwitcher(); else openSwitcher(); });
		card.append(body, close);
		grid.appendChild(card);
	}
	const addCard = document.createElement("button");
	addCard.type = "button";
	addCard.className = "rj-card rj-card-add";
	addCard.textContent = "+ new tab";
	addCard.addEventListener("click", () => { newTab(); closeSwitcher(); });
	grid.appendChild(addCard);
	sw.hidden = false;
}
function closeSwitcher() {
	document.getElementById("rj-switcher").hidden = true;
}
document.getElementById("rj-tabsbtn").addEventListener("click", () => {
	const sw = document.getElementById("rj-switcher");
	sw.hidden ? openSwitcher() : closeSwitcher();
});
document.getElementById("rj-switcher-close").addEventListener("click", closeSwitcher);

function activateTab(tab) {
	activeTab = tab;
	for (const t of tabs) {
		if (t.frame) t.frame.frame.style.display = t === tab ? "block" : "none";
	}
	hideFind();
	const pagehost = document.getElementById("rj-pagehost");
	if (tab.page) {
		document.body.classList.remove("in-flight");
		document.body.classList.add("page-view");
		pagehost.hidden = false;
		renderTabs();
		return;
	}
	document.body.classList.remove("page-view");
	pagehost.hidden = true;
	if (tab.frame) {
		document.body.classList.add("in-flight");
		syncBar();
	} else if (tab.url) {
		ensureReady().then(() => { if (activeTab === tab && !tab.frame) ignite(tab.url); }).catch(() => {});
	} else {
		document.body.classList.remove("in-flight");
		address.value = "";
		address.focus();
	}
	renderTabs();
}

function newPageTab(page) {
	const existing = tabs.find((t) => t.page === page);
	if (existing) { activateTab(existing); return existing; }
	if (tabs.length >= 8) { setStatus("8 tabs is plenty", "error"); return null; }
	const tab = { id: ++tabSeq, frame: null, url: null, title: "", page };
	tabs.push(tab);
	activateTab(tab);
	return tab;
}

function newTab(url) {
	if (tabs.length >= 8) { setStatus("8 tabs is plenty", "error"); return; }
	const tab = { id: ++tabSeq, frame: null, url: null, title: "" };
	tabs.push(tab);
	activateTab(tab);
	if (url) ignite(url);
	return tab;
}

function closeTab(tab) {
	const i = tabs.indexOf(tab);
	if (i < 0) return;
	if (tab.frame) tab.frame.frame.remove();
	tabs.splice(i, 1);
	if (tab === activeTab) {
		activeTab = null;
		const next = tabs[Math.min(i, tabs.length - 1)];
		if (next) activateTab(next);
		else {
			document.body.classList.remove("in-flight");
			address.value = "";
			renderTabs();
		}
	} else {
		renderTabs();
	}
}

function ensureFrame(tab) {
	if (tab.frame) return tab.frame;
	const f = scramjet.createFrame();
	f.frame.className = "rj-tabframe";
	f.frame.addEventListener("load", () => {
		try {
			const t = f.frame.contentWindow.document.title;
			if (t) tab.title = t.length > 24 ? t.slice(0, 23) + "\u2026" : t;
		} catch (err) {}
		try {
			const doc = f.frame.contentWindow.document;
			const link = doc.querySelector("link[rel~='icon'], link[rel='shortcut icon'], link[rel='apple-touch-icon']");
			let iconUrl = link && link.href ? link.href : null;
			if (!iconUrl) {
				const origin = new URL(f.frame.contentWindow.location.href).origin;
				if (origin && origin.startsWith("http") && origin !== location.origin) iconUrl = origin + "/favicon.ico";
			}
			if (iconUrl && iconUrl.startsWith(location.origin)) iconUrl = null;
			if (iconUrl) {
				const w = f.frame.contentWindow;
				w.fetch(iconUrl).then((r) => { if (!r.ok) throw new Error("icon " + r.status); return r.blob(); }).then((b) => {
					if (b.size > 0 && b.size < 1048576) { tab.icon = URL.createObjectURL(b); renderTabs(); }
				}).catch(() => {});
			}
		} catch (err) {}
		if (tab === activeTab) { syncBar(); setStatus("", "idle"); }
		renderTabs();
		wireFrameDoc(tab, f);
	});
	frameHost.appendChild(f.frame);
	tab.frame = f;
	return f;
}

// -- persisted settings ------------------------------------------------------
const SETTINGS_KEY = "rj.settings";
const BOOKMARKS_KEY = "rj.bookmarks";
const HISTORY_KEY = "rj.history";
const TABS_KEY = "rj.tabs";

const DEFAULTS = {
	theme: "amber",
	engine: "ddg",
	cloak: "off",
	panicKey: "`",
	panicUrl: "https://www.google.com",
	zoom: "100",
	clearOnExit: false,
};

let settings = { ...DEFAULTS };
try { Object.assign(settings, JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}")); } catch (err) {}
function saveSettings() { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); scheduleSyncPush(); }

let bookmarks = [];
try { bookmarks = JSON.parse(localStorage.getItem(BOOKMARKS_KEY) || "[]"); } catch (err) {}
function saveBookmarks() { localStorage.setItem(BOOKMARKS_KEY, JSON.stringify(bookmarks)); scheduleSyncPush(); }

const HISTORY_MAX_AGE_MS = 7 * 24 * 3600 * 1000; // v0.4: history auto-purges past 7 days
let history = [];
try { history = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]"); } catch (err) {}
history = history.filter((h) => h && h.ts && Date.now() - h.ts < HISTORY_MAX_AGE_MS);
function saveHistory() {
	history = history.filter((h) => h && h.ts && Date.now() - h.ts < HISTORY_MAX_AGE_MS);
	localStorage.setItem(HISTORY_KEY, JSON.stringify(history)); scheduleSyncPush();
}
function recordHistory(url) {
	if (!url) return;
	history = history.filter((h) => h.url !== url);
	history.unshift({ url, ts: Date.now() });
	history = history.slice(0, 100);
	saveHistory();
	renderDial();
}

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

function applyZoom() {
	for (const t of tabs) {
		if (t.frame) t.frame.frame.style.zoom = settings.zoom + "%";
	}
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
			const registration = await navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" });
			registration.update();
			if (!navigator.serviceWorker.controller) {
				await new Promise((resolve) => {
					navigator.serviceWorker.addEventListener("controllerchange", () => resolve(), { once: true });
					setTimeout(resolve, 10000);
				});
			}
			await navigator.serviceWorker.ready;
			const readySw = navigator.serviceWorker.controller || registration.active;
			if (!readySw) throw new Error("service worker not ready");
			const wispUrl =
				(location.protocol === "https:" ? "wss" : "ws") +
				"://" +
				location.host +
				"/wisp/";
			const { default: LibcurlClient } = await import("/libcurl/index.mjs");
			const transport = new LibcurlClient({ wisp: wispUrl });
			const controller = new $scramjetController.Controller({
				serviceworker: readySw,
				transport,
				scramjetConfig: $scramjet.defaultConfig,
			});
			window.__rjController = controller;
			await controller.wait();
			scramjet = {
				createFrame() {
					const fr = controller.createFrame();
					return { go: (u) => fr.go(u), frame: fr.element, _raw: fr };
				},
			};
		})();
	}
	return swReady;
}

// turns whatever was typed into a real url (or a search)
function resolveInput(raw) {
	const input = peelProxied(raw.trim());
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
	if (!activeTab) newTab();
	const tab = activeTab;
	const f = ensureFrame(tab);
	f.go(url);
	tab.url = url;
	let host = url;
	try { host = new URL(url).hostname; } catch (err) {}
	if (!tab.title) tab.title = host;
	document.body.classList.add("in-flight");
	f.frame.style.display = "block";
	setStatus("Waiting for " + host + "\u2026", "busy");
	renderTabs();
}

function peelProxied(href) {
	// v2 URL shape: /~/sj/<scramtag>/<codec>/<encodeURIComponent(realUrl)>
	const prefix = location.origin + "/~/sj/";
	let out = href;
	if (href.startsWith(prefix)) {
		try {
			const seg = href.slice(prefix.length).split("/").filter(Boolean).pop();
			const dec = decodeURIComponent(seg || "");
			if (/^(https?|about|data|blob):/.test(dec)) out = dec;
		} catch (err) { return href; }
	}
	// v2 appends its own $-prefixed tracking params to proxied URLs; hide them
	out = out.replace(/([?&])\$[^&#]*(&|$)/g, (m, p1, p2) => (p2 === "&" ? p1 : ""));
	out = out.replace(/\?$/, "");
	return out;
}

function syncBar() {
	if (!activeTab || !activeTab.frame) return;
	try {
		const loc = activeTab.frame.frame.contentWindow.location;
		const href = loc.href;
		if (href === "about:blank") return;
		// show the real destination, not our encoded proxy path
		const real = peelProxied(href);
		if (real === href && href.includes("/~/sj/")) return; // still mid-redirect
		address.value = real;
		if (activeTab) activeTab.url = real;
		syncStar();
		recordHistory(real);
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
function renderBmBar() {
	const bar = document.getElementById("rj-bmbar");
	if (!bar) return;
	bar.innerHTML = "";
	for (const b of bookmarks.slice(0, 40)) {
		const chip = document.createElement("button");
		chip.type = "button";
		chip.className = "rj-bm";
		let host = b.url;
		try { host = new URL(b.url).hostname.replace(/^www\./, ""); } catch (err) {}
		chip.textContent = host;
		chip.title = b.url;
		chip.addEventListener("click", () => {
			if (activeTab && !activeTab.page) { ignite(b.url); }
			else { newTab(); ignite(b.url); }
		});
		bar.appendChild(chip);
	}
	document.body.classList.toggle("bmbar", bookmarks.length > 0);
}

function renderBookmarks() {
	renderBmBar();
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
function openSettings() {
	newPageTab("settings");
	return;
}
function closeSettings() {
	if (activeTab && activeTab.page) closeTab(activeTab);
}
document.getElementById("rj-gear").addEventListener("click", openSettings);
document.getElementById("rj-gear2").addEventListener("click", openSettings);
document.getElementById("rj-panel-close").addEventListener("click", closeSettings);

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
	zoomSel.value = settings.zoom;
	clearHistToggle.checked = !!settings.clearOnExit;
}

// -- shortcuts + panic --------------------------------------------------------
document.addEventListener("keydown", (e) => {
	if (e.key === settings.panicKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
		window.location.replace(settings.panicUrl || DEFAULTS.panicUrl);
		return;
	}
	if (e.key === "Escape" && activeTab && activeTab.page) { closeSettings(); return; }
	if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "l") {
		e.preventDefault();
		address.focus();
		address.select();
		return;
	}
	if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f" && document.body.classList.contains("in-flight")) {
		e.preventDefault();
		openFind();
		return;
	}
	if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "t") {
		e.preventDefault();
		newTab();
		return;
	}
	if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "w") {
		e.preventDefault();
		if (activeTab) closeTab(activeTab);
		return;
	}
	if (e.altKey && e.key === "ArrowLeft") {
		if (activeTab && activeTab.frame) activeTab.frame.frame.contentWindow.history.back();
		return;
	}
	if (e.altKey && e.key === "ArrowRight") {
		if (activeTab && activeTab.frame) activeTab.frame.frame.contentWindow.history.forward();
		return;
	}
	const typing = document.activeElement === address || document.activeElement === panicUrlIn || document.activeElement === findIn;
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
	if (activeTab && activeTab.frame) activeTab.frame.frame.contentWindow.history.back();
});
document.getElementById("rj-fwd").addEventListener("click", () => {
	if (activeTab && activeTab.frame) activeTab.frame.frame.contentWindow.history.forward();
});
document.getElementById("rj-reload").addEventListener("click", () => {
	if (activeTab && activeTab.frame) activeTab.frame.frame.contentWindow.location.reload();
});
document.getElementById("rj-home").addEventListener("click", () => {
	if (activeTab && activeTab.frame) newTab();
	else { address.value = ""; address.focus(); }
});


// -- v0.3: history panel, address autocomplete, fullscreen, about:blank popout, dark pages --
const suggest = document.getElementById("rj-suggest");
let suggestItems = [];
let suggestIndex = -1;

function hideSuggest() {
	suggest.hidden = true;
	suggestIndex = -1;
}
function suggestCandidates(q) {
	const needle = q.trim().toLowerCase();
	if (needle.length < 2) return [];
	const seen = new Set();
	const out = [];
	const push = (url, kind) => {
		if (seen.has(url) || out.length >= 6) return;
		seen.add(url);
		out.push({ url, kind });
	};
	for (const b of bookmarks) if (b.url.toLowerCase().includes(needle)) push(b.url, "star");
	for (const h of history) if (h.url.toLowerCase().includes(needle)) push(h.url, "hist");
	return out;
}
function renderSuggest(q) {
	suggestItems = suggestCandidates(q);
	suggest.innerHTML = "";
	if (!suggestItems.length) { hideSuggest(); return; }
	suggestItems.forEach((item, i) => {
		const row = document.createElement("button");
		row.type = "button";
		row.className = "rj-sug-row";
		let host = item.url;
		try { host = new URL(item.url).hostname; } catch (err) {}
		const icon = document.createElement("span");
		icon.className = "rj-sug-icon";
		icon.textContent = item.kind === "star" ? "\u2605" : "\u21ba";
		const label = document.createElement("span");
		label.className = "rj-sug-label";
		label.textContent = item.url;
		row.append(icon, label);
		row.title = item.url;
		row.addEventListener("mousedown", (e) => {
			e.preventDefault();
			address.value = item.url;
			hideSuggest();
			form.requestSubmit();
		});
		if (i === suggestIndex) row.classList.add("active");
		suggest.appendChild(row);
	});
	suggest.hidden = false;
}
address.addEventListener("input", () => { suggestIndex = -1; renderSuggest(address.value); });
address.addEventListener("blur", () => { hideSuggest(); });
address.addEventListener("keydown", (e) => {
	if (suggest.hidden) return;
	if (e.key === "ArrowDown" || e.key === "ArrowUp") {
		e.preventDefault();
		const d = e.key === "ArrowDown" ? 1 : -1;
		suggestIndex = (suggestIndex + d + suggestItems.length) % suggestItems.length;
		renderSuggest(address.value);
	} else if (e.key === "Enter" && suggestIndex >= 0) {
		e.preventDefault();
		address.value = suggestItems[suggestIndex].url;
		hideSuggest();
		form.requestSubmit();
	} else if (e.key === "Escape") {
		hideSuggest();
		e.stopPropagation();
	}
});

// history in the panel
function renderHistory() {
	const list = document.getElementById("rj-history");
	if (!list) return;
	list.innerHTML = "";
	if (!history.length) {
		const li = document.createElement("li");
		li.className = "rj-bm-empty";
		li.textContent = "nothing yet - where you fly shows up here";
		list.appendChild(li);
		return;
	}
	for (const h of history.slice(0, 20)) {
		const li = document.createElement("li");
		const open = document.createElement("button");
		open.type = "button";
		open.className = "rj-bm-open";
		let host = h.url;
		try { host = new URL(h.url).hostname; } catch (err) {}
		open.textContent = host;
		open.title = h.url;
		open.addEventListener("click", () => { closeSettings(); ignite(h.url); });
		li.append(open);
		list.appendChild(li);
	}
}
document.getElementById("rj-history-clear").addEventListener("click", () => {
	history = [];
	saveHistory();
	renderHistory();
});

// fullscreen chrome toggle
const fsBtn = document.getElementById("rj-fs");
fsBtn.addEventListener("click", () => {
	document.body.classList.toggle("no-chrome");
});
document.getElementById("rj-peek").addEventListener("mouseenter", () => {
	document.body.classList.remove("no-chrome");
});

// about:blank popout - current page, no ramjet chrome, tab says nothing
document.getElementById("rj-popout").addEventListener("click", () => {
	if (!activeTab || !activeTab.frame) return;
	const src = activeTab.frame.frame.src;
	if (!src || src === "about:blank") return;
	const w = window.open("about:blank", "_blank");
	if (!w) { setStatus("popup blocked - allow popups for this site", "error"); return; }
	w.document.write("<!doctype html><html><head><title></title><style>html,body{margin:0;height:100%;overflow:hidden;background:#fff}iframe{border:0;width:100%;height:100%;display:block}</style></head><body><iframe src=\"" + src.replace(/"/g, "&quot;") + "\"></iframe></body></html>");
	w.document.close();
});

// zoom
const zoomSel = document.getElementById("rj-zoom");
zoomSel.addEventListener("change", () => {
	settings.zoom = zoomSel.value;
	saveSettings();
	applyZoom();
});
// clear history on exit
const clearHistToggle = document.getElementById("rj-clearhist");
clearHistToggle.addEventListener("change", () => {
	settings.clearOnExit = clearHistToggle.checked;
	saveSettings();
});
window.addEventListener("beforeunload", () => {
	if (settings.clearOnExit) localStorage.removeItem(HISTORY_KEY);
});


// -- in-page controls: ctrl/cmd+click and middle-click open tabs, custom right-click menu --
function decodeProxied(href) {
	const prefix = location.origin + "/scramjet/";
	return href.startsWith(prefix) ? decodeURIComponent(href.slice(prefix.length)) : href;
}
function wireFrameDoc(tab, f) {
	let doc;
	try { doc = f.frame.contentWindow.document; } catch (err) { return; }
	if (!doc) return;
	const linkAt = (e) => (e.target && e.target.closest ? e.target.closest("a[href]") : null);
	doc.addEventListener("click", (e) => {
		if (!(e.ctrlKey || e.metaKey)) return;
		const a = linkAt(e);
		if (!a) return;
		e.preventDefault();
		e.stopPropagation();
		newTab(decodeProxied(a.href));
	}, true);
	doc.addEventListener("auxclick", (e) => {
		if (e.button !== 1) return;
		const a = linkAt(e);
		if (!a) return;
		e.preventDefault();
		e.stopPropagation();
		newTab(decodeProxied(a.href));
	}, true);
	doc.addEventListener("mouseover", (e) => {
		const a = linkAt(e);
		if (!a || tab !== activeTab) return;
		try { setStatus(decodeProxied(a.href), "idle"); } catch (err) {}
	});
	doc.addEventListener("mouseout", (e) => {
		if (!linkAt(e) || tab !== activeTab) return;
		setStatus("", "idle");
	});
	doc.addEventListener("contextmenu", (e) => {
		e.preventDefault();
		const rect = f.frame.getBoundingClientRect();
		const a = linkAt(e);
		openMenu(rect.left + e.clientX, rect.top + e.clientY, a ? decodeProxied(a.href) : null, tab);
	}, true);
}

const menu = document.getElementById("rj-menu");
function hideMenu() { menu.hidden = true; }
function menuItem(label, fn) {
	const b = document.createElement("button");
	b.type = "button";
	b.className = "rj-menu-item";
	b.textContent = label;
	b.addEventListener("click", () => { hideMenu(); fn(); });
	return b;
}
function menuSep() {
	const d = document.createElement("div");
	d.className = "rj-menu-sep";
	return d;
}
function openMenu(x, y, linkUrl, tab) {
	menu.innerHTML = "";
	if (linkUrl) {
		menu.appendChild(menuItem("open link in new tab", () => newTab(linkUrl)));
		menu.appendChild(menuItem("copy link", () => {
			if (navigator.clipboard) navigator.clipboard.writeText(linkUrl).catch(() => {});
		}));
		menu.appendChild(menuSep());
	}
	menu.appendChild(menuItem("back", () => { if (tab.frame) tab.frame.frame.contentWindow.history.back(); }));
	menu.appendChild(menuItem("forward", () => { if (tab.frame) tab.frame.frame.contentWindow.history.forward(); }));
	menu.appendChild(menuItem("reload", () => { if (tab.frame) tab.frame.frame.contentWindow.location.reload(); }));
	menu.appendChild(menuItem("bookmark this page", () => {
		const u = tab.url;
		if (u && !isBookmarked(u)) {
			bookmarks.unshift({ url: u, ts: Date.now() });
			bookmarks = bookmarks.slice(0, 50);
			saveBookmarks();
			syncStar();
		}
	}));
	menu.hidden = false;
	menu.style.left = Math.min(x, window.innerWidth - menu.offsetWidth - 8) + "px";
	menu.style.top = Math.min(y, window.innerHeight - menu.offsetHeight - 8) + "px";
}
document.addEventListener("click", hideMenu);
document.addEventListener("keydown", (e) => { if (e.key === "Escape") hideMenu(); });
window.addEventListener("blur", hideMenu);


// -- tab strip context menu --
function openTabMenu(x, y, tab) {
	menu.innerHTML = "";
	menu.appendChild(menuItem("duplicate", () => { if (tab.url) newTab(tab.url); }));
	menu.appendChild(menuItem("close other tabs", () => {
		for (const t of tabs.slice()) if (t !== tab) closeTab(t);
	}));
	menu.appendChild(menuItem("close tab", () => closeTab(tab)));
	menu.hidden = false;
	menu.style.left = Math.min(x, window.innerWidth - menu.offsetWidth - 8) + "px";
	menu.style.top = Math.min(y, window.innerHeight - menu.offsetHeight - 8) + "px";
}

// -- find in page --
const findBar = document.getElementById("rj-find");
const findIn = document.getElementById("rj-find-in");
function openFind() {
	if (!document.body.classList.contains("in-flight")) return;
	findBar.hidden = false;
	findIn.focus();
	findIn.select();
}
function hideFind() { findBar.hidden = true; }
function doFind(back) {
	const w = activeTab && activeTab.frame ? activeTab.frame.frame.contentWindow : null;
	if (!w || !findIn.value) return;
	let ok = false;
	try { ok = w.find(findIn.value, false, !!back, true, false, true, false); } catch (err) {}
	findIn.classList.toggle("miss", !ok);
}
findIn.addEventListener("input", () => doFind(false));
findIn.addEventListener("keydown", (e) => {
	if (e.key === "Enter") { e.preventDefault(); doFind(e.shiftKey); }
	if (e.key === "Escape") { hideFind(); address.focus(); e.stopPropagation(); }
});
document.getElementById("rj-find-x").addEventListener("click", () => { hideFind(); address.focus(); });

// -- speed dial on the landing --
function renderDial() {
	const dial = document.getElementById("rj-dial");
	dial.innerHTML = "";
	const seen = new Set();
	const picks = [];
	for (const h of history) {
		let host;
		try { host = new URL(h.url).hostname; } catch (err) { continue; }
		if (seen.has(host)) continue;
		seen.add(host);
		picks.push({ host, url: h.url });
		if (picks.length >= 6) break;
	}
	for (const b of bookmarks) {
		let host;
		try { host = new URL(b.url).hostname; } catch (err) { continue; }
		if (seen.has(host)) continue;
		seen.add(host);
		picks.push({ host, url: b.url });
		if (picks.length >= 6) break;
	}
	for (const p of picks) {
		const chip = document.createElement("button");
		chip.type = "button";
		chip.className = "rj-chip";
		chip.textContent = p.host;
		chip.title = p.url;
		chip.addEventListener("click", () => { address.value = p.url; form.requestSubmit(); });
		dial.appendChild(chip);
	}
}

// -- zero-knowledge sync + account --------------------------------------------
let syncTimer = null;
let meInfo = null; // { user, role }
function scheduleSyncPush() {
	if (typeof RJCrypto === "undefined" || !RJCrypto.unlocked()) return;
	clearTimeout(syncTimer);
	syncTimer = setTimeout(async () => {
		try {
			await RJCrypto.push({ history: history.slice(0, 200), bookmarks: bookmarks.slice(0, 100), settings });
			markSync("synced");
		} catch (err) { markSync("sync failed"); }
	}, 800);
}
function markSync(txt) {
	const el = document.getElementById("rj-sync-state");
	if (el) el.textContent = txt;
}
async function hydrateFromServer() {
	try {
		const meRes = await fetch("/auth/me");
		if (!meRes.ok) { renderAccount(); return; }
		meInfo = await meRes.json();
		const data = await RJCrypto.pull();
		if (data) {
			if (Array.isArray(data.history)) { history = data.history.slice(0, 200); localStorage.setItem(HISTORY_KEY, JSON.stringify(history)); }
			if (Array.isArray(data.bookmarks)) { bookmarks = data.bookmarks.slice(0, 100); localStorage.setItem(BOOKMARKS_KEY, JSON.stringify(bookmarks)); }
			if (data.settings && typeof data.settings === "object") {
				settings = { ...DEFAULTS, ...data.settings };
				localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
			}
			applyTheme();
			applyCloak();
			applyZoom();
			syncSettingsUI();
			renderBookmarks();
			renderHistory();
			renderDial();
			syncStar();
			markSync("synced");
		} else {
			markSync("locked");
		}
	} catch (err) {}
	renderAccount();
}
function renderAccount() {
	const box = document.getElementById("rj-acct");
	if (!box) return;
	box.innerHTML = "";
	if (!meInfo || !meInfo.user) {
		box.textContent = "not signed in";
		return;
	}
	const row = document.createElement("div");
	row.className = "rj-row";
	row.style.justifyContent = "space-between";
	const who = document.createElement("span");
	who.textContent = meInfo.user + (meInfo.role === "admin" ? " (admin)" : "");
	const state = document.createElement("span");
	state.id = "rj-sync-state";
	state.style.color = "#7d838d";
	state.style.fontSize = "12px";
	state.textContent = RJCrypto.unlocked() ? "synced" : "locked";
	row.appendChild(who);
	row.appendChild(state);
	box.appendChild(row);

	const btns = document.createElement("div");
	btns.className = "rj-row";
	btns.style.marginTop = "8px";
	const mk = (label, fn) => {
		const b = document.createElement("button");
		b.type = "button";
		b.className = "rj-mini";
		b.textContent = label;
		b.addEventListener("click", fn);
		btns.appendChild(b);
		return b;
	};
	if (!RJCrypto.unlocked()) {
		mk("unlock sync", async () => {
			const pw = prompt("password to unlock your encrypted data:");
			if (!pw) return;
			const ok = await RJCrypto.unlockWithPassword(pw);
			if (ok) { await hydrateFromServer(); }
			else alert("could not unlock - wrong password?");
		});
	}
	mk("change password", async () => {
		const oldPw = prompt("current password:");
		if (!oldPw) return;
		const newPw = prompt("new password (4+ chars):");
		if (!newPw || newPw.length < 4) { alert("new password too short"); return; }
		const r = await RJCrypto.changePassword(oldPw, newPw);
		alert(r.ok ? "password changed" : ("failed: " + (r.error || "unknown")));
	});
	mk("sign out", async () => {
		await RJCrypto.lock();
		location.href = "/auth/logout";
	});
	box.appendChild(btns);

	if (meInfo.role === "admin") {
		document.getElementById("rj-admin-sec").hidden = false;
		renderAdmin();
	}
}
async function renderAdmin() {
	const box = document.getElementById("rj-admin");
	if (!box) return;
	let data;
	try {
		const res = await fetch("/auth/admin/users");
		if (!res.ok) return;
		data = await res.json();
	} catch { return; }
	box.innerHTML = "";
	for (const u of data.users) {
		const row = document.createElement("div");
		row.className = "rj-row";
		row.style.justifyContent = "space-between";
		const label = document.createElement("span");
		label.textContent = u.username + " - " + u.status + (u.role === "admin" ? " (admin)" : "");
		row.appendChild(label);
		const acts = document.createElement("span");
		if (u.username !== meInfo.user) {
			const mk = (txt, action) => {
				const b = document.createElement("button");
				b.type = "button";
				b.className = "rj-mini";
				b.textContent = txt;
				b.style.marginLeft = "6px";
				b.addEventListener("click", async () => {
					await fetch("/auth/admin/" + action, {
						method: "POST",
						headers: { "content-type": "application/x-www-form-urlencoded" },
						body: "username=" + encodeURIComponent(u.username),
					});
					renderAdmin();
				});
				acts.appendChild(b);
			};
			if (u.status === "pending") mk("approve", "approve");
			if (u.status === "pending") mk("deny", "deny");
			if (u.status === "denied") mk("approve", "approve");
			mk("remove", "remove");
		}
		row.appendChild(acts);
		box.appendChild(row);
	}
	const tog = document.getElementById("rj-require-approval");
	tog.checked = !!data.requireApproval;
	tog.onchange = async () => {
		await fetch("/auth/admin/config", {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: "requireApproval=" + (tog.checked ? "1" : "0"),
		});
	};
	const adt = document.getElementById("rj-adblock");
	if (adt) {
		adt.checked = data.adblock !== false;
		adt.onchange = async () => {
			await fetch("/auth/admin/config", {
				method: "POST",
				headers: { "content-type": "application/x-www-form-urlencoded" },
				body: "adblock=" + (adt.checked ? "1" : "0"),
			});
		};
	}
}

// warm the engine in the background once the page is idle
if ("requestIdleCallback" in window) {
	requestIdleCallback(() => ensureReady().catch(() => {}), { timeout: 4000 });
}

let savedTabs = { tabs: [], active: 0 };
try { savedTabs = JSON.parse(localStorage.getItem(TABS_KEY) || '{"tabs":[],"active":0}'); } catch (err) {}
for (const st of savedTabs.tabs || []) {
	if (tabs.length >= 8) break;
	tabs.push({ id: ++tabSeq, frame: null, url: st.url || null, title: st.title || "", page: st.page || null, icon: st.icon || null });
}
if (tabs.length) {
	activateTab(tabs[Math.max(0, Math.min(savedTabs.active || 0, tabs.length - 1))]);
}

applyTheme();
applyCloak();
syncSettingsUI();
renderBookmarks();
renderDial();
setStatus("", "idle");
hydrateFromServer();
address.focus();
