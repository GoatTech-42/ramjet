// Ramjet client - ignition logic + settings, bookmarks, history, cloak, panic. GoatTech, 2026. MIT.
"use strict";

const APP_VERSION = "0.7.0-alpha"; // bump every release; index.html + labels + asset params follow
// stale-client self-heal: mixed HTML/JS from caches gets one clean reload
if (window.RJ_VERSION && window.RJ_VERSION !== APP_VERSION && !sessionStorage.getItem("rj-reheal")) {
	sessionStorage.setItem("rj-reheal", "1");
	location.reload();
} else {
	sessionStorage.removeItem("rj-reheal");
}

// Scramjet v2: controller + transport are created in ensureReady() once the
// routing service worker controls the page.
let scramjet = null; // { createFrame } shim over the v2 Controller
let currentSettingsPage = "appearance";

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
		document.getElementById("rj-panel-card").hidden = tab.page !== "settings";
		document.getElementById("rj-dl-card").hidden = tab.page !== "downloads";
		document.getElementById("rj-hist-card").hidden = tab.page !== "history";
		if (tab.page === "settings") setSettingsPage(currentSettingsPage);
		if (tab.page === "downloads") renderDownloads();
		if (tab.page === "history") renderHistoryPage();
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
			document.body.classList.remove("page-view");
			document.getElementById("rj-pagehost").hidden = true;
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
			const w = f.frame.contentWindow;
			if (w.location.origin === location.origin && (w.location.pathname.startsWith("/searx/") || w.location.pathname.startsWith("/search"))) {
				tab.direct = true;
				w.document.addEventListener("click", (ev) => {
					const a = ev.target && ev.target.closest ? ev.target.closest("a[href]") : null;
					if (!a) return;
					const href = a.href;
					if (!href) return;
					const hp = href.startsWith(location.origin) ? href.slice(location.origin.length) : href;
					if (hp.startsWith("/searx/") || hp.startsWith("/search") || hp.startsWith("/th?") || hp.startsWith("/th/")) return;
					if (/^https?:/.test(href)) { ev.preventDefault(); ignite(href); }
				}, true);
			}
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
		if (tab === activeTab) { syncBar(); setStatus("", "idle"); scheduleStoragePush(); }
		renderTabs();
		wireFrameDoc(tab, f);
	});
	frameHost.appendChild(f.frame);
	tab.frame = f;
	return f;
}

// -- downloads manager ---------------------------------------------------------
// the service worker hands attachment responses here; we fetch the bytes
// ourselves so progress, pause/resume and in-browser open all work.
const DLS_KEY = "rj.downloads";
let downloads = [];
let dlSeq = 0;
try {
	downloads = JSON.parse(localStorage.getItem(DLS_KEY) || "[]");
	for (const d of downloads) {
		d.chunks = []; d.received = 0; d.ctrl = null; d.blob = null; d.objUrl = null;
		if (d.state === "downloading" || d.state === "paused") d.state = "interrupted";
		dlSeq = Math.max(dlSeq, d.id || 0);
	}
} catch (err) { downloads = []; }

function saveDlMeta() {
	try {
		localStorage.setItem(DLS_KEY, JSON.stringify(downloads.map((d) => ({
			id: d.id, url: d.url, name: d.name, size: d.size, mime: d.mime,
			state: d.state, error: d.error || null,
			started: d.started, finished: d.finished || null,
		}))));
	} catch (err) {}
}

function fmtSize(n) {
	if (!n) return "";
	const u = ["B", "KB", "MB", "GB"];
	let i = 0;
	while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
	return (n >= 100 ? Math.round(n) : n.toFixed(1)) + " " + u[i];
}

function dlHost(url) {
	try { return new URL(peelProxied(url) || url).hostname; } catch (err) { return ""; }
}

navigator.serviceWorker.addEventListener("message", (ev) => {
	const d = ev.data;
	if (!d || d.type !== "rj:download") return;
	let dlName = (d.name || "").replace(/[\\/]/g, "_");
	if (!dlName || dlName.indexOf("%3A") !== -1 || dlName.indexOf("%2F") !== -1) {
		// sw fell back to the proxied path tail - peel to the real file name
		try {
			const real = peelProxied(d.url);
			const tail = real ? new URL(real).pathname.split("/").pop() : "";
			dlName = tail || dlName;
		} catch (err) {}
	}
	if (!dlName) dlName = "download";
	const entry = {
		id: ++dlSeq, url: d.url, name: dlName,
		size: d.size || 0, mime: d.mime || "", state: "downloading",
		received: 0, chunks: [], ctrl: null, blob: null, objUrl: null,
		started: Date.now(), finished: null, error: null,
	};
	downloads.unshift(entry);
	dlRun(entry, false);
	saveDlMeta();
	renderDlBadge();
	setStatus("downloading " + entry.name, "idle");
	if (activeTab && activeTab.page === "downloads") renderDownloads();
});

async function dlRun(entry, resume) {
	const headers = { "x-rj-dlm": "1" };
	if (resume && entry.received > 0) headers["range"] = "bytes=" + entry.received + "-";
	entry.ctrl = new AbortController();
	entry.state = "downloading";
	renderDownloads(); renderDlBadge();
	try {
		const res = await fetch(normalizeUrl(entry.url), { headers, signal: entry.ctrl.signal });
		if (resume && res.status === 200 && entry.received > 0) { entry.chunks = []; entry.received = 0; }
		if (!res.ok && res.status !== 206) throw new Error("http " + res.status);
		const len = Number(res.headers.get("content-length")) || 0;
		if (len) entry.size = entry.received + len;
		const reader = res.body.getReader();
		for (;;) {
			const r = await reader.read();
			if (r.done) break;
			entry.chunks.push(r.value);
			entry.received += r.value.length;
			dlProgressPaint(entry);
		}
		entry.blob = new Blob(entry.chunks, { type: entry.mime || "application/octet-stream" });
		entry.chunks = [];
		entry.state = "done";
		entry.finished = Date.now();
		setStatus(entry.name + " downloaded", "idle");
	} catch (err) {
		if (entry.state !== "paused") { entry.state = "error"; entry.error = String((err && err.message) || err); }
	}
	entry.ctrl = null;
	saveDlMeta();
	renderDownloads(); renderDlBadge();
}

function dlProgressPaint(entry) {
	if (!entry._bar) return;
	if (entry.size) entry._bar.style.width = Math.min(100, (entry.received / entry.size) * 100) + "%";
	if (entry._meta) entry._meta.textContent = dlMetaText(entry);
}

function dlMetaText(d) {
	const got = fmtSize(d.received);
	if (d.state === "done") return fmtSize(d.size || d.received) + " - done";
	if (d.state === "paused") return got + (d.size ? " of " + fmtSize(d.size) : "") + " - paused";
	if (d.state === "error") return "failed - " + (d.error || "unknown");
	if (d.state === "interrupted") return "interrupted - retry to restart";
	return got + (d.size ? " of " + fmtSize(d.size) : "");
}

function dlPause(d) { d.state = "paused"; if (d.ctrl) d.ctrl.abort(); saveDlMeta(); renderDownloads(); renderDlBadge(); }
function dlResume(d) { dlRun(d, true); }
function dlForget(d) {
	if (d.ctrl) d.ctrl.abort();
	if (d.objUrl) URL.revokeObjectURL(d.objUrl);
	downloads = downloads.filter((x) => x !== d);
	saveDlMeta(); renderDownloads(); renderDlBadge();
}
function dlSave(d) {
	if (!d.blob) return;
	const url = d.objUrl || (d.objUrl = URL.createObjectURL(d.blob));
	const a = document.createElement("a");
	a.href = url;
	a.download = d.name;
	document.body.appendChild(a);
	a.click();
	a.remove();
}
function dlOpenTab(d) {
	if (!d.blob) return;
	if (tabs.length >= 8) { setStatus("8 tabs is plenty", "error"); return; }
	const tab = { id: ++tabSeq, frame: null, url: "", title: d.name };
	const ifr = document.createElement("iframe");
	ifr.className = "rj-tabframe";
	ifr.src = d.objUrl || (d.objUrl = URL.createObjectURL(d.blob));
	tab.frame = { frame: ifr };
	tabs.push(tab);
	frameHost.appendChild(ifr);
	activateTab(tab);
}

function dlAction(label, fn, cls) {
	const b = document.createElement("button");
	b.type = "button";
	b.className = cls || "rj-action";
	b.textContent = label;
	b.addEventListener("click", (ev) => { ev.stopPropagation(); fn(); });
	return b;
}

function renderDlBadge() {
	const n = downloads.filter((d) => d.state === "downloading").length;
	for (const id of ["rj-dl-badge", "rj-dl-badge2"]) {
		const el = document.getElementById(id);
		if (!el) continue;
		el.hidden = n === 0;
		el.textContent = n;
	}
}

function renderDownloads() {
	const list = document.getElementById("rj-dl-list");
	if (!list) return;
	list.textContent = "";
	document.getElementById("rj-dl-empty").hidden = downloads.length > 0;
	document.getElementById("rj-dl-clear").hidden = !downloads.some((d) => d.state !== "downloading");
	for (const d of downloads) {
		const row = document.createElement("div");
		row.className = "rj-dl-row";
		const main = document.createElement("div");
		main.className = "rj-dl-main";
		const name = document.createElement("div");
		name.className = "rj-dl-name";
		name.textContent = d.name;
		name.title = d.name;
		const meta = document.createElement("div");
		meta.className = "rj-dl-meta";
		meta.textContent = (dlHost(d.url) ? dlHost(d.url) + " - " : "") + dlMetaText(d);
		const bar = document.createElement("div");
		bar.className = "rj-dl-bar" + (d.state === "downloading" && !d.size ? " rj-dl-indet" : "");
		const fill = document.createElement("div");
		if (d.state === "done") fill.style.width = "100%";
		else if (d.size) fill.style.width = Math.min(100, (d.received / d.size) * 100) + "%";
		bar.appendChild(fill);
		main.appendChild(name);
		main.appendChild(meta);
		if (d.state === "downloading" || d.state === "paused") main.appendChild(bar);
		d._bar = d.state === "downloading" ? fill : null;
		d._meta = d.state === "downloading" ? meta : null;
		const acts = document.createElement("div");
		acts.className = "rj-dl-acts";
		if (d.state === "downloading") {
			acts.appendChild(dlAction("pause", () => dlPause(d)));
			acts.appendChild(dlAction("cancel", () => dlForget(d), "rj-mini"));
		} else if (d.state === "paused") {
			acts.appendChild(dlAction("resume", () => dlResume(d)));
			acts.appendChild(dlAction("cancel", () => dlForget(d), "rj-mini"));
		} else if (d.state === "done") {
			acts.appendChild(dlAction("save", () => dlSave(d)));
			acts.appendChild(dlAction("open in tab", () => dlOpenTab(d)));
			acts.appendChild(dlAction("remove", () => dlForget(d), "rj-mini"));
		} else {
			acts.appendChild(dlAction("retry", () => { d.received = 0; d.chunks = []; d.error = null; dlRun(d, false); }));
			acts.appendChild(dlAction("remove", () => dlForget(d), "rj-mini"));
		}
		row.appendChild(main);
		row.appendChild(acts);
		list.appendChild(row);
	}
}

function openDownloads() { newPageTab("downloads"); }
document.getElementById("rj-dlbtn").addEventListener("click", openDownloads);
document.getElementById("rj-dlbtn2").addEventListener("click", openDownloads);
document.getElementById("rj-dl-close").addEventListener("click", () => { if (activeTab && activeTab.page) closeTab(activeTab); });
document.getElementById("rj-dl-clear").addEventListener("click", () => {
	for (const d of [...downloads]) if (d.state !== "downloading") dlForget(d);
	renderDownloads();
});
renderDlBadge();

// -- history page --------------------------------------------------------------
function openHistory() { newPageTab("history"); }

function histTime(ts) {
	const d = new Date(ts);
	const today = new Date();
	const sameDay = d.toDateString() === today.toDateString();
	if (sameDay) return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
	return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

function renderHistoryPage() {
	const list = document.getElementById("rj-hist-list");
	if (!list) return;
	const q = (document.getElementById("rj-hist-q").value || "").trim().toLowerCase();
	list.textContent = "";
	const matches = history.filter((h) => !q || h.url.toLowerCase().includes(q) || (h.title || "").toLowerCase().includes(q));
	document.getElementById("rj-hist-empty").hidden = matches.length > 0;
	// group by site, most recent group first
	const groups = [];
	const byHost = {};
	for (const h of matches) {
		let host = h.url;
		try { host = new URL(h.url).hostname; } catch (err) {}
		if (!byHost[host]) { byHost[host] = { host, entries: [], latest: 0 }; groups.push(byHost[host]); }
		byHost[host].entries.push(h);
		if (h.ts > byHost[host].latest) byHost[host].latest = h.ts;
	}
	groups.sort((a, b) => b.latest - a.latest);
	for (const g of groups) {
		const wrap = document.createElement("div");
		wrap.className = "rj-hist-group";
		const head = document.createElement("div");
		head.className = "rj-hist-site";
		const label = document.createElement("span");
		label.textContent = g.host + " (" + g.entries.length + ")";
		const siteClear = document.createElement("button");
		siteClear.type = "button";
		siteClear.className = "rj-mini";
		siteClear.textContent = "clear site";
		siteClear.addEventListener("click", () => {
			history = history.filter((h) => { try { return new URL(h.url).hostname !== g.host; } catch (err) { return true; } });
			saveHistory();
			renderHistoryPage();
		});
		head.appendChild(label);
		head.appendChild(siteClear);
		wrap.appendChild(head);
		for (const h of g.entries) {
			const row = document.createElement("div");
			row.className = "rj-hist-entry";
			const link = document.createElement("button");
			link.type = "button";
			link.className = "rj-hist-link";
			link.textContent = h.title || h.url;
			link.title = h.url;
			link.addEventListener("click", () => { newTab(); ignite(h.url); });
			const time = document.createElement("span");
			time.className = "rj-hist-time";
			time.textContent = histTime(h.ts);
			const rm = document.createElement("button");
			rm.type = "button";
			rm.className = "rj-mini";
			rm.textContent = "\u00d7";
			rm.setAttribute("aria-label", "Remove");
			rm.addEventListener("click", () => {
				history = history.filter((x) => x !== h);
				saveHistory();
				renderHistoryPage();
			});
			row.appendChild(link);
			row.appendChild(time);
			row.appendChild(rm);
			wrap.appendChild(row);
		}
		list.appendChild(wrap);
	}
}

document.getElementById("rj-hist-q").addEventListener("input", renderHistoryPage);
document.getElementById("rj-hist-close").addEventListener("click", () => { if (activeTab && activeTab.page) closeTab(activeTab); });
document.getElementById("rj-history-page").addEventListener("click", openHistory);
document.getElementById("rj-hist-clear").addEventListener("click", () => {
	const range = document.getElementById("rj-hist-range").value;
	let cutoff = 0;
	const now = new Date();
	if (range === "hour") cutoff = Date.now() - 3600e3;
	else if (range === "day") cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
	else { history = []; saveHistory(); renderHistoryPage(); return; }
	history = history.filter((h) => h.ts < cutoff);
	saveHistory();
	renderHistoryPage();
});

// -- persisted settings ------------------------------------------------------
const SETTINGS_KEY = "rj.settings";
const BOOKMARKS_KEY = "rj.bookmarks";
const HISTORY_KEY = "rj.history";
const TABS_KEY = "rj.tabs";

const DEFAULTS = {
	theme: "amber",
	engine: "rj",
	cloak: "off",
	panicKey: "`",
	panicUrl: "https://www.google.com",
	zoom: "100",
	clearOnExit: false,
	restoreTabs: true,
	customEngineName: "",
	customEngineUrl: "",
};

let settings = { ...DEFAULTS };
try { Object.assign(settings, JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}")); } catch (err) {}
// v0.9.0 one-time migration: the old default engine was ddg - users who never
// picked one move to ramjet search; explicit picks (non-ddg) stay untouched.
try {
	if (settings.engine === "ddg" && !localStorage.getItem("rj.engine-migrated-v090")) {
		settings.engine = "rj";
		localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
		localStorage.setItem("rj.engine-migrated-v090", "1");
	}
} catch (err) {}
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
function recordHistory(url, title) {
	if (!url) return;
	const prev = history.find((h) => h.url === url);
	history = history.filter((h) => h.url !== url);
	history.unshift({ url, ts: Date.now(), title: title || (prev && prev.title) || "" });
	history = history.slice(0, 1000);
	saveHistory();
}

const THEMES = {
	amber:  ["#ffa028", "#c96f04"],
	mint:   ["#34d399", "#059669"],
	sky:    ["#38bdf8", "#0369a1"],
	violet: ["#a78bfa", "#6d28d9"],
	ember:  ["#f87171", "#b91c1c"],
};

const ENGINES = {
	rj:     ["ramjet search", "/search?q="],
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

function accentColors() {
	if (settings.theme === "custom") {
		const amber = settings.customAccent || "#ffa028";
		return [amber, shadeHex(amber, -0.35)];
	}
	return THEMES[settings.theme] || THEMES.amber;
}
function faviconSvg(amber, deep) {
	return "data:image/svg+xml," + encodeURIComponent(
		'<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">' +
		'<path fill="' + amber + '" d="M11.6 39.6 L14.4 42.4 L4.7 50.7 L3.3 49.3 Z"/>' +
		'<path fill="' + amber + '" d="M20.6 48.6 L23.4 51.4 L15.7 57.7 L14.3 56.3 Z"/>' +
		'<path fill="' + deep + '" d="M58 6 L12 22 L30 32 Z"/>' +
		'<path fill="' + amber + '" d="M58 6 L30 32 L40 50 Z"/></svg>');
}

function applyTheme() {
	const [amber, deep] = accentColors();
	document.documentElement.style.setProperty("--amber", amber);
	document.documentElement.style.setProperty("--amber-deep", deep);
	const favicon = document.querySelector('link[rel="icon"]');
	if (favicon) favicon.href = faviconSvg(amber, deep);
	const customBtn = document.getElementById("rj-theme-custom");
	if (customBtn) customBtn.style.setProperty("--sw", amber);
}
function shadeHex(hex, amt) {
	const n = parseInt(hex.slice(1), 16);
	const ch = (v) => Math.max(0, Math.min(255, Math.round(v * (1 + amt))));
	return "#" + [ch(n >> 16), ch((n >> 8) & 255), ch(n & 255)].map((v) => v.toString(16).padStart(2, "0")).join("");
}

function applyZoom() {
	for (const t of tabs) {
		if (t.frame) t.frame.frame.style.zoom = settings.zoom + "%";
	}
}

function applyCloak() {
	const key = CLOAKS[settings.cloak] ? settings.cloak : "off";
	document.title = CLOAKS[key][0];
	let link = document.querySelector('link[rel="icon"]');
	if (!link) {
		link = document.createElement("link");
		link.rel = "icon";
		document.head.appendChild(link);
	}
	link.href = key === "off" ? faviconSvg(...accentColors()) : CLOAKS[key][1];
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
			// v0.10.4: note whether a worker pre-exists - the boot-timeout self
			// heal below only makes sense against a stale worker, not a slow
			// first registration.
			window.__rjHadPriorSw = !!(await navigator.serviceWorker.getRegistration());
			const registration = await navigator.serviceWorker.register("/sw.js?v=35", { updateViaCache: "none" });
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
					rjHookFrameErrors(fr);
					rjWatchFrameNav(fr);
					return { go: (u) => { try { if (fr.__rjArmNav) fr.__rjArmNav(u); } catch (e) {} return fr.go(u); }, frame: fr.element, _raw: fr };
				},
			};
		})();
	}
	try {
		const ready = await Promise.race([swReady, new Promise((_, rej) => setTimeout(() => rej(new Error("engine boot timeout")), 12000))]);
		sessionStorage.removeItem("rjSwReset");
		return ready;
	} catch (err) {
		// v0.10.1: a stale service worker can hold a dead engine handshake -
		// drop it and reload once; the fresh worker boots clean.
		// v0.10.4: only when a worker pre-existed. With no prior worker the
		// timeout just means a slow first registration (tunneled networks) -
		// and right after a self-heal the re-registration is the slowest boot
		// there is, so a second timeout must wait the boot out, not fail it.
		if (!sessionStorage.getItem("rjSwReset") && window.__rjHadPriorSw) {
			sessionStorage.setItem("rjSwReset", "1");
			try { const regs = await navigator.serviceWorker.getRegistrations(); await Promise.all(regs.map((r) => r.unregister())); } catch (e2) {}
			location.reload();
			await new Promise(() => {});
		}
		sessionStorage.removeItem("rjSwReset");
		return await swReady;
	}
}

// -- error surfaces ------------------------------------------------------------
// when the engine can't fetch a page (dead host, timeout, refused, tls) the
// controller asks our hook for a response; we serve a ramjet-flavored error
// page instead of the browser's dead frame.
function rjErrorPageHtml(rawUrl, err) {
	let real = String(rawUrl || "");
	try {
		const u = new URL(real);
		real = decodeURIComponent(u.pathname.split("/").pop() || real);
	} catch (e) {}
	let host = real;
	try { host = new URL(real).host; } catch (e) {}
	const msg = String((err && (err.message || err)) || "");
	let title = "this page didn't load";
	let why = "something went wrong on the way to the page.";
	if (!navigator.onLine) {
		title = "you're offline";
		why = "ramjet can't reach the internet right now. check your connection and try again.";
	} else if (/resolve|dns|notfound|getaddrinfo|name or service/i.test(msg)) {
		title = "can't find " + host;
		why = "that address doesn't exist. check for a typo and try again.";
	} else if (/timed?\s?out|timeout|deadline/i.test(msg)) {
		title = host + " took too long";
		why = "the site isn't answering. it might be busy or down - try again in a bit.";
	} else if (/refused/i.test(msg)) {
		title = host + " refused the connection";
		why = "the site is reachable but wouldn't accept the connection.";
	} else if (/ssl|tls|certificate|cert/i.test(msg)) {
		title = "certificate problem at " + host;
		why = "the site's security certificate couldn't be verified, so the connection was stopped.";
	} else if (/reset|abort|closed/i.test(msg)) {
		title = "connection dropped";
		why = "the site dropped the connection mid-load.";
	}
	const [amber, deep] = accentColors();
	const esc = (t) => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
	return "<!doctype html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">" +
		"<title>" + esc(title) + "</title><style>" +
		"html,body{margin:0;height:100%}body{background:#0b0c0e;color:#e8e9eb;font:14px system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;" +
		"display:flex;align-items:center;justify-content:center;padding:24px;box-sizing:border-box}" +
		".c{max-width:420px;text-align:center}" +
		"svg{width:46px;height:46px;margin-bottom:18px}" +
		"h1{font-size:19px;font-weight:600;margin:0 0 10px;word-break:break-word}" +
		".why{color:#8a8f98;font-size:13.5px;line-height:1.5;margin:0 0 6px}" +
		".url{color:#5c626b;font:12px ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-all;margin:10px 0 22px}" +
		".row{display:flex;gap:10px;justify-content:center}" +
		"button{font:13.5px system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;border-radius:7px;padding:8px 18px;cursor:pointer;border:1px solid transparent}" +
		".go{background:" + amber + ";color:#14100a;font-weight:600;border-color:" + amber + "}" +
		".back{background:transparent;color:#e8e9eb;border-color:#2c313a}" +
		".back:hover{border-color:#3a404a}" +
		"</style></head><body><div class=\"c\">" +
		"<svg viewBox=\"0 0 64 64\"><path fill=\"" + amber + "\" d=\"M11.6 39.6 L14.4 42.4 L4.7 50.7 L3.3 49.3 Z\"/>" +
		"<path fill=\"" + amber + "\" d=\"M20.6 48.6 L23.4 51.4 L15.7 57.7 L14.3 56.3 Z\"/>" +
		"<path fill=\"" + deep + "\" d=\"M58 6 L12 22 L30 32 Z\"/><path fill=\"" + amber + "\" d=\"M58 6 L30 32 L40 50 Z\"/></svg>" +
		"<h1>" + esc(title) + "</h1>" +
		"<p class=\"why\">" + esc(why) + "</p>" +
		(real ? "<p class=\"url\">" + esc(real) + "</p>" : "") +
		"<div class=\"row\"><button class=\"go\" onclick=\"location.reload()\">try again</button>" +
		"<button class=\"back\" onclick=\"history.back()\">go back</button></div>" +
		"</div></body></html>";
}

function rjHookFrameErrors(fr) {
	try {
		$scramjet.Tap.tap(fr.hooks.error.request, async (ctx, props) => {
			try {
				const dest = ctx.rawrequest && ctx.rawrequest.destination;
				if (dest && dest !== "document" && dest !== "iframe") return;
				props.suppressError = true;
				props.setResponse = {
					body: rjErrorPageHtml(ctx.rawrequest ? ctx.rawrequest.rawUrl : "", ctx.error),
					status: 200,
					statusText: "OK",
					headers: [["content-type", "text/html; charset=utf-8"]],
				};
			} catch (e) {}
		});
	} catch (e) {}
}

// page-side watchdog, two covers for the failures the engine never surfaces:
// 1. hang cover: the fetch hook observes every navigation request start (typed,
//    clicked, redirected); the frame's load event disarms the timer. silent-drop
//    hosts never answer and never error - at 15s we draw the error page ourselves.
// 2. dead-page cover: when the fetch chain dies outright the browser commits its
//    own chrome-error page, which fires load with an inaccessible (null) document.
//    we detect that and swap in the ramjet page.
function rjWatchFrameNav(fr) {
	try {
		const el = fr.element;
		let timer = null;
		let pending = null;
		const disarm = () => { if (timer) { clearTimeout(timer); timer = null; } pending = null; };
		const draw = (realUrl, err) => {
			try {
				let html = rjErrorPageHtml(realUrl, err);
				// srcdoc pages reload themselves on location.reload() - point
				// try again at the attempted proxied address instead
				let retry = "";
				try { retry = el.getAttribute("src") || ""; } catch (e) {}
				if (retry) html = html.replace('onclick="location.reload()"', 'onclick="location.replace(' + JSON.stringify(retry).replace(/"/g, "&quot;") + ')"');
				el.srcdoc = html;
				// keep the bar showing the failed address, not about:srcdoc
				try {
					const t = tabs.find((tb) => tb.frame && tb.frame.frame === el);
					if (t && realUrl) { t.url = realUrl; if (t === activeTab) address.value = realUrl; }
				} catch (e) {}
			} catch (e) {}
		};
		el.addEventListener("load", () => {
			disarm();
			setTimeout(() => {
				try {
					if (el.srcdoc) return; // our own error page committed
					if (el.contentDocument === null) draw(el.__rjLast || "", new Error("page failed to load"));
				} catch (e) {}
			}, 60);
		});
		const arm = (realUrl) => {
			if (timer) clearTimeout(timer);
			pending = realUrl || "";
			el.__rjLast = pending;
			timer = setTimeout(() => {
				timer = null;
				if (!pending) return;
				const url = pending; pending = null;
				draw(url, new Error("navigation timed out"));
			}, 15000);
		};
		fr.__rjArmNav = arm;
		$scramjet.Tap.tap(fr.hooks.fetch, (ctx) => {
			try {
				const dest = ctx && ctx.rawrequest && ctx.rawrequest.destination;
				if (dest !== "document" && dest !== "iframe") return;
				arm((ctx.rawrequest && ctx.rawrequest.rawUrl) || "");
			} catch (e) {}
		});
	} catch (e) {}
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
	let eng = ENGINES[settings.engine];
	if (settings.engine === "custom" && settings.customEngineUrl) eng = [settings.customEngineName || "custom", settings.customEngineUrl];
	if (!eng) eng = ENGINES.ddg;
	if (eng[1].includes("%s")) return eng[1].replace("%s", encodeURIComponent(input));
	return eng[1] + encodeURIComponent(input);
}

// v0.10.2: synced tabs/history/bookmarks/downloads can carry absolute URLs
// stamped with another ramjet origin (saved on the port-forwarded host, used
// on the tunnel). Rewrite anything aimed at this app's own paths to the
// origin we are actually served on, so traffic never leaves the serving host.
// v0.10.3: only origins ramjet is actually served on may own app paths -
// an unrestricted rewrite would hijack real sites living at /search
// (google.com/search being the big one).
const KNOWN_ORIGINS = [
	"https://server.lukeevanson.com:4201",
	"https://hy24zctweohap7bcg5bji6ylfm.srv.us",
	"https://cpt4insmln3kexmghw73slfzoy.srv.us",
	"http://127.0.0.1:14204", "http://localhost:14204",
	"http://127.0.0.1:14214", "http://localhost:14214",
];
let recordedOrigins = [];
try { recordedOrigins = JSON.parse(localStorage.getItem("rj.origins") || "[]"); } catch (err) {}
if (!recordedOrigins.includes(location.origin)) {
	recordedOrigins.push(location.origin);
	try { localStorage.setItem("rj.origins", JSON.stringify(recordedOrigins.slice(-8))); } catch (err) {}
}
function isOwnOrigin(origin) {
	return origin === location.origin || KNOWN_ORIGINS.includes(origin) || recordedOrigins.includes(origin);
}

function normalizeUrl(url) {
	try {
		const u = new URL(url, location.origin);
		if (u.origin === location.origin) return url;
		if (u.pathname.startsWith("/~/sj/") && isOwnOrigin(u.origin)) {
			// proxied URL stamped with another origin - recover the destination
			const seg = u.pathname.slice("/~/sj/".length).split("/").filter(Boolean).pop();
			const dec = decodeURIComponent(seg || "");
			if (/^https?:/.test(dec)) return dec;
			return url;
		}
		if (isOwnOrigin(u.origin) && (u.pathname === "/search" || u.pathname === "/th" || u.pathname.startsWith("/searx/") || (u.pathname === "/" && u.searchParams.has("u")))) {
			return location.origin + u.pathname + u.search + u.hash;
		}
	} catch (err) {}
	return url;
}

function ignite(url) {
	if (!activeTab) newTab();
	const tab = activeTab;
	const f = ensureFrame(tab);
	url = normalizeUrl(url);
	if (url.startsWith(location.origin + "/")) url = url.slice(location.origin.length);
	if (url.startsWith("/searx/") || url.startsWith("/search")) {
		// same-origin search: no scramjet wrap - the frame's own session cookie
		// passes the /searx gate, and wisp never sees a loopback destination
		tab.direct = true;
		f.frame.src = url;
	} else {
		tab.direct = false;
		f.go(url);
	}
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
		if (href === "about:blank" || href === "about:srcdoc") return; // srcdoc = our error page, keep the failed address in the bar
		// show the real destination, not our encoded proxy path
		const real = peelProxied(href);
		if (real === href && href.includes("/~/sj/")) return; // still mid-redirect
		let disp = real;
		if (real.startsWith(location.origin + "/search") || real.startsWith(location.origin + "/searx/search")) {
			try {
				const q = new URL(real).searchParams.get("q");
				if (q) disp = "ramjet search: " + q;
			} catch (err) {}
		}
		address.value = disp;
		if (activeTab) activeTab.url = real;
		syncStar();
		recordHistory(real, activeTab.title);
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
function setSettingsPage(page) {
	currentSettingsPage = page;
	let first = true;
	for (const sec of document.querySelectorAll("#rj-panel-card > section")) {
		const show = sec.dataset.page === page;
		sec.style.display = show ? "" : "none";
		if (show) {
			sec.style.borderTop = first ? "0" : "";
			first = false;
		}
	}
	for (const b of document.querySelectorAll("#rj-setnav button")) b.classList.toggle("active", b.dataset.page === page);
}
for (const b of document.querySelectorAll("#rj-setnav button")) {
	b.addEventListener("click", () => setSettingsPage(b.dataset.page));
}

function openSettings() {
	loadChangelog();
	renderSiteStorage();
	setSettingsPage("appearance");
	newPageTab("settings");
	return;
}
function closeSettings() {
	if (activeTab && activeTab.page) closeTab(activeTab);
}
document.getElementById("rj-gear").addEventListener("click", openSettings);
document.getElementById("rj-gear2").addEventListener("click", openSettings);
document.getElementById("rj-panel-close").addEventListener("click", closeSettings);
document.getElementById("rj-storage-clearall").addEventListener("click", async () => {
	if (!confirm("clear ALL site storage? this logs you out of every site")) return;
	await storeWrite("{}");
	for (const [host, entries] of Object.entries(collectSiteStorage())) {
		for (const k of Object.keys(entries)) localStorage.removeItem(host + "@" + k);
	}
	scheduleStoragePush();
	renderSiteStorage();
});

// theme buttons
for (const btn of document.querySelectorAll("#rj-themes button")) {
	btn.addEventListener("click", () => {
		settings.theme = btn.dataset.theme;
		if (settings.theme === "custom" && !settings.customAccent) settings.customAccent = "#ffa028";
		saveSettings();
		applyTheme();
		syncSettingsUI();
	});
}
const customAccentIn = document.getElementById("rj-custom-accent");
customAccentIn.addEventListener("input", () => {
	settings.theme = "custom";
	settings.customAccent = customAccentIn.value;
	saveSettings();
	applyTheme();
	syncSettingsUI();
});
// engine select
const engineSel = document.getElementById("rj-engine");
engineSel.addEventListener("change", () => {
	settings.engine = engineSel.value;
	customEngineRow.hidden = settings.engine !== "custom";
	saveSettings();
});
// custom search engine
const customEngineRow = document.getElementById("rj-custom-engine-row");
const customEngineName = document.getElementById("rj-custom-engine-name");
const customEngineUrl = document.getElementById("rj-custom-engine-url");
customEngineName.addEventListener("change", () => { settings.customEngineName = customEngineName.value.trim(); saveSettings(); });
customEngineUrl.addEventListener("change", () => { settings.customEngineUrl = customEngineUrl.value.trim(); saveSettings(); });
// startup: reopen last session's tabs
const restoreTabsToggle = document.getElementById("rj-restore-tabs");
restoreTabsToggle.addEventListener("change", () => { settings.restoreTabs = restoreTabsToggle.checked; saveSettings(); });
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
	document.getElementById("rj-custom-row").hidden = settings.theme !== "custom";
	if (settings.customAccent) customAccentIn.value = settings.customAccent;
	clearHistToggle.checked = !!settings.clearOnExit;
	customEngineRow.hidden = settings.engine !== "custom";
	customEngineName.value = settings.customEngineName || "";
	customEngineUrl.value = settings.customEngineUrl || "";
	restoreTabsToggle.checked = settings.restoreTabs !== false;
}


// -- changelog ----------------------------------------------------------------
let changelogLoaded = false;
async function loadChangelog() {
	if (changelogLoaded) return;
	const box = document.getElementById("rj-changelog");
	try {
		const res = await fetch("/CHANGELOG.md", { cache: "no-store" });
		if (!res.ok) throw new Error("no changelog");
		const md = await res.text();
		box.innerHTML = renderChangelog(md);
		changelogLoaded = true;
	} catch (err) {
		box.innerHTML = '<p class="rj-muted">no changelog yet</p>';
	}
}
function renderChangelog(md) {
	const esc = (t) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
	let html = "", inList = false;
	for (const raw of md.split("\n")) {
		const line = raw.trim();
		if (line.startsWith("## ")) {
			if (inList) { html += "</ul>"; inList = false; }
			html += "<h4>" + esc(line.slice(3)) + "</h4>";
		} else if (line.startsWith("- ")) {
			if (!inList) { html += "<ul>"; inList = true; }
			html += "<li>" + esc(line.slice(2)) + "</li>";
		} else if (line && !line.startsWith("# ")) {
			if (inList) { html += "</ul>"; inList = false; }
			html += "<p>" + esc(line) + "</p>";
		}
	}
	if (inList) html += "</ul>";
	return html || '<p class="rj-muted">no changelog yet</p>';
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
	if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "h") {
		e.preventDefault();
		openHistory();
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
		if (seen.has(url) || out.length >= 3) return;
		seen.add(url);
		out.push({ url, kind });
	};
	for (const b of bookmarks) if (b.url.toLowerCase().includes(needle)) push(b.url, "star");
	for (const h of history) if (h.url.toLowerCase().includes(needle)) push(h.url, "hist");
	return out;
}
// display text for a suggestion row: engine suggestions and ramjet-search
// history entries show the query, everything else shows the url
function sugLabel(item) {
	if (item.label) return item.label;
	const px = location.origin + "/search?q=";
	const pxOld = location.origin + "/searx/search?q=";
	if (item.url.startsWith(px) || item.url.startsWith(pxOld)) {
		try { return new URL(item.url).searchParams.get("q") || item.url; } catch (err) {}
	}
	// v0.10.2: the same paths stamped with another ramjet origin (synced state)
	try {
		const su = new URL(item.url);
		if (isOwnOrigin(su.origin) && (su.pathname === "/search" || su.pathname === "/searx/search")) return su.searchParams.get("q") || item.url;
	} catch (err) {}
	return item.url;
}

// live suggestions from the ramjet search engine's own autocomplete
let sugTimer = null, lastSugQ = null, lastEngSugs = [];
function engineSuggestUrl(q) {
	let eng = ENGINES[settings.engine];
	if (settings.engine === "custom" && settings.customEngineUrl) eng = ["custom", settings.customEngineUrl];
	if (!eng || !eng[1].startsWith("/searx/")) return null;
	return eng[1].replace("/search?q=", "/autocompleter?q=") + encodeURIComponent(q);
}
function renderSuggest(q) {
	const needle = q.trim();
	const local = suggestCandidates(q);
	const paint = () => {
		suggestItems = [...lastEngSugs, ...local];
		suggest.innerHTML = "";
		if (!suggestItems.length) { hideSuggest(); return; }
		suggestItems.forEach((item, i) => {
			const row = document.createElement("button");
			row.type = "button";
			row.className = "rj-sug-row";
			row.dataset.kind = item.kind;
			const icon = document.createElement("span");
			icon.className = "rj-sug-icon";
			icon.textContent = item.kind === "star" ? "\u2605" : item.kind === "search" ? "\u2315" : "\u21ba";
			const label = document.createElement("span");
			label.className = "rj-sug-label";
			label.textContent = sugLabel(item);
			row.append(icon, label);
			row.title = item.url;
			row.addEventListener("mousedown", (e) => {
				e.preventDefault();
				address.value = item.kind === "search" ? (item.label || item.url) : item.url;
				hideSuggest();
				form.requestSubmit();
			});
			if (i === suggestIndex) row.classList.add("active");
			suggest.appendChild(row);
		});
		suggest.hidden = false;
	};
	if (needle === lastSugQ) { paint(); return; }
	lastSugQ = needle;
	lastEngSugs = [];
	paint(); // local matches instantly, engine suggestions land a beat later
	clearTimeout(sugTimer);
	const api = needle.length >= 2 ? engineSuggestUrl(needle) : null;
	if (!api) return;
	sugTimer = setTimeout(async () => {
		try {
			const r = await fetch(api, { credentials: "same-origin" });
			const data = await r.json();
			const sugs = Array.isArray(data) && Array.isArray(data[1]) ? data[1] : [];
			if (lastSugQ !== needle || address.value.trim() !== needle) return;
			lastEngSugs = sugs.slice(0, 4).map((t) => ({ url: resolveInput(t) || (ENGINES.rj[1] + encodeURIComponent(t)), kind: "search", label: t }));
			paint();
		} catch (err) {}
	}, 150);
}
address.addEventListener("input", () => { suggestIndex = -1; hideSuggest(); }); // v0.9.2: suggestions removed per Luke
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
	// popout targets the most recent real tab - when settings/downloads/history
	// is the active page-tab, activeTab has no frame and nothing would happen.
	let target = null;
	for (let i = tabs.length - 1; i >= 0; i--) {
		if (tabs[i].frame && tabs[i].frame.frame && tabs[i].frame.frame.src) { target = tabs[i]; break; }
	}
	if (!target) { setStatus("open a site first", "error"); return; }
	const src = target.frame.frame.src;
	if (!src || src === "about:blank") return;
	const html = "<!doctype html><html><head><title></title><style>html,body{margin:0;height:100%;overflow:hidden;background:#fff}iframe{border:0;width:100%;height:100%;display:block}</style></head><body><iframe src=\"" + src.replace(/"/g, "&quot;") + "\"></iframe></body></html>";
	// PWAs (home-screen apps) and popup-blocked browsers refuse window.open -
	// fall back to swapping this tab's document so the popout still works there.
	let w = null;
	try { w = window.open("about:blank"); } catch (err) {}
	if (w) {
		try {
			w.document.open();
			w.document.write(html);
			w.document.close();
			return;
		} catch (err) {}
		try { w.close(); } catch (err) {}
	}
	document.write(html);
	document.close();
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

// -- overflow menu: the bar shows essentials; the rest lives behind the dots --
const MORE_ITEMS = [
	["rj-fwd", "forward"],
	["rj-reload", "reload"],
	["rj-home", "home"],
	["rj-star", "bookmark this page"],
	["rj-dlbtn", "downloads"],
	["rj-cloak", "tab cloak"],
	["rj-gear2", "settings"],
	["rj-fs", "hide the bar"],
	["rj-logout", "lock ramjet"],
];
const moreBtn = document.getElementById("rj-more");
moreBtn.addEventListener("click", (e) => {
	e.stopPropagation();
	if (!menu.hidden) { hideMenu(); return; }
	menu.innerHTML = "";
	let added = 0;
	for (const [id, label] of MORE_ITEMS) {
		const el = document.getElementById(id);
		if (!el || el.offsetParent !== null) continue; // visible in the bar - not overflowed
		if (added === 5) menu.appendChild(menuSep());
		menu.appendChild(menuItem(label, () => el.click()));
		added++;
	}
	if (!added) return;
	const r = moreBtn.getBoundingClientRect();
	menu.hidden = false;
	menu.style.left = Math.max(8, Math.min(r.right - menu.offsetWidth, window.innerWidth - menu.offsetWidth - 8)) + "px";
	menu.style.top = (r.bottom + 6) + "px";
});


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

// -- storage sync (admin only): site logins follow the account across devices.
// The scramjet controller cookie db is the local source of truth; we read and
// write it directly so the controller picks changes up via its BroadcastChannel.
const STORE_DB = "__scramjet_controller", STORE_STORE = "state", STORE_KEY = "cookies";
const STORE_CHAN = "__scramjet_controller_channel";
function storeDb() {
	return new Promise((resolve, reject) => {
		const req = indexedDB.open(STORE_DB, 1);
		req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains(STORE_STORE)) req.result.createObjectStore(STORE_STORE); };
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});
}
async function storeRead() {
	try {
		const db = await storeDb();
		return await new Promise((resolve) => {
			const tx = db.transaction(STORE_STORE, "readonly").objectStore(STORE_STORE).get(STORE_KEY);
			tx.onsuccess = () => resolve(tx.result || null);
			tx.onerror = () => resolve(null);
		});
	} catch (err) { return null; }
}
async function storeWrite(cookies) {
	const db = await storeDb();
	const updatedAt = Date.now();
	await new Promise((resolve, reject) => {
		const tx = db.transaction(STORE_STORE, "readwrite");
		tx.objectStore(STORE_STORE).put({ updatedAt, cookies }, STORE_KEY);
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error);
	});
	try { new BroadcastChannel(STORE_CHAN).postMessage({ updatedAt }); } catch (err) {}
}
function storageSyncOn() {
	return typeof RJCrypto !== "undefined" && RJCrypto.unlocked() && meInfo && meInfo.role === "admin";
}
let storeSyncTimer = null;
function scheduleStoragePush() {
	if (!storageSyncOn()) return;
	clearTimeout(storeSyncTimer);
	storeSyncTimer = setTimeout(pushStorageNow, 4000);
}
function collectSiteStorage() {
	const out = {};
	for (let i = 0; i < localStorage.length; i++) {
		const k = localStorage.key(i);
		const at = k.indexOf("@");
		if (at < 1) continue;
		const host = k.slice(0, at), key = k.slice(at + 1);
		if (!/^[a-z0-9.-]+(:\d+)?$/i.test(host)) continue; // scramjet site keys are host@key
		(out[host] = out[host] || {})[key] = localStorage.getItem(k);
	}
	return out;
}
async function pushStorageNow() {
	if (!storageSyncOn()) return;
	try {
		const state = await storeRead();
		const sites = collectSiteStorage();
		const cookies = state && typeof state.cookies === "string" && state.cookies ? state.cookies : null;
		if (!cookies && !Object.keys(sites).length) return;
		const ok = await RJCrypto.pushStorage({ cookies, sitestorage: sites, syncedAt: Date.now() });
		if (ok) { localStorage.setItem("rj-store-ts", String(Date.now())); markSync("synced"); }
	} catch (err) {}
}
// -- site storage manager (feature 5): per-site cookies + site data ----------
async function jarMutate(fn) {
	const state = await storeRead();
	let jar = {};
	try { jar = state && state.cookies ? JSON.parse(state.cookies) : {}; } catch (err) {}
	fn(jar);
	await storeWrite(JSON.stringify(jar));
	scheduleStoragePush();
}
async function renderSiteStorage() {
	const box = document.getElementById("rj-storage");
	if (!box) return;
	const state = await storeRead();
	let jar = {};
	try { jar = state && state.cookies ? JSON.parse(state.cookies) : {}; } catch (err) {}
	const bySite = {};
	for (const [id, c] of Object.entries(jar)) {
		if (!c || typeof c !== "object") continue;
		const dom = (c.domain || "").replace(/^\./, "") || "(unknown)";
		(bySite[dom] = bySite[dom] || { cookies: [], storage: {} }).cookies.push({ id, ...c });
	}
	for (const [host, entries] of Object.entries(collectSiteStorage())) {
		(bySite[host] = bySite[host] || { cookies: [], storage: {} }).storage = entries;
	}
	const hosts = Object.keys(bySite).sort();
	if (!hosts.length) { box.innerHTML = '<p class="rj-muted">nothing stored yet</p>'; return; }
	box.innerHTML = "";
	for (const host of hosts) {
		const info = bySite[host];
		const lsBytes = Object.entries(info.storage).reduce((n, [k, v]) => n + k.length + String(v).length, 0);
		const cBytes = info.cookies.reduce((n, c) => n + (c.name || "").length + (c.value || "").length, 0);
		const wrap = document.createElement("div");
		wrap.className = "rj-store-site";
		const head = document.createElement("div");
		head.className = "rj-store-head";
		head.innerHTML = '<span class="rj-store-host"></span><span class="rj-muted rj-store-meta"></span><button type="button" class="rj-mini" data-act="view">view</button><button type="button" class="rj-mini" data-act="clear">clear</button>';
		head.querySelector(".rj-store-host").textContent = host;
		head.querySelector(".rj-store-meta").textContent = info.cookies.length + " cookies \u00b7 " + ((lsBytes + cBytes) / 1024).toFixed(1) + " KB";
		const detail = document.createElement("div");
		detail.className = "rj-store-detail";
		detail.hidden = true;
		head.querySelector('[data-act="view"]').addEventListener("click", () => {
			detail.hidden = !detail.hidden;
			head.querySelector('[data-act="view"]').textContent = detail.hidden ? "view" : "hide";
		});
		head.querySelector('[data-act="clear"]').addEventListener("click", async () => {
			await jarMutate((j) => { for (const [id, c] of Object.entries(j)) { if (((c.domain || "").replace(/^\./, "")) === host) delete j[id]; } });
			for (const k of Object.keys(info.storage)) localStorage.removeItem(host + "@" + k);
			scheduleStoragePush();
			renderSiteStorage();
		});
		if (info.cookies.length) {
			const h = document.createElement("p");
			h.className = "rj-muted rj-store-sub";
			h.textContent = "cookies";
			detail.appendChild(h);
			for (const c of info.cookies.sort((a, b) => (a.name || "").localeCompare(b.name || ""))) {
				const r = document.createElement("div");
				r.className = "rj-store-line";
				r.innerHTML = '<span class="rj-store-k"></span><input class="rj-store-v" type="text" spellcheck="false"><button type="button" class="rj-mini">del</button>';
				r.querySelector(".rj-store-k").textContent = c.name;
				const inp = r.querySelector(".rj-store-v");
				inp.value = c.value || "";
				inp.addEventListener("change", async () => {
					const v = inp.value;
					await jarMutate((j) => { if (j[c.id]) j[c.id].value = v; });
				});
				r.querySelector(".rj-mini").addEventListener("click", async () => {
					await jarMutate((j) => { delete j[c.id]; });
					renderSiteStorage();
				});
				detail.appendChild(r);
			}
		}
		const siteKeys = Object.keys(info.storage).sort();
		if (siteKeys.length) {
			const h = document.createElement("p");
			h.className = "rj-muted rj-store-sub";
			h.textContent = "site data";
			detail.appendChild(h);
			for (const k of siteKeys) {
				const r = document.createElement("div");
				r.className = "rj-store-line";
				r.innerHTML = '<span class="rj-store-k"></span><input class="rj-store-v" type="text" spellcheck="false"><button type="button" class="rj-mini">del</button>';
				r.querySelector(".rj-store-k").textContent = k;
				const inp = r.querySelector(".rj-store-v");
				inp.value = info.storage[k];
				inp.addEventListener("change", () => { localStorage.setItem(host + "@" + k, inp.value); scheduleStoragePush(); });
				r.querySelector(".rj-mini").addEventListener("click", () => { localStorage.removeItem(host + "@" + k); scheduleStoragePush(); renderSiteStorage(); });
				detail.appendChild(r);
			}
		}
		wrap.appendChild(head);
		wrap.appendChild(detail);
		box.appendChild(wrap);
	}
}

async function hydrateStorage() {
	if (!meInfo || meInfo.role !== "admin" || typeof RJCrypto === "undefined" || !RJCrypto.unlocked()) return;
	try {
		const data = await RJCrypto.pullStorage();
		if (!data || (!data.cookies && !data.sitestorage)) return;
		const ts = data.syncedAt || 0;
		if (ts <= +(localStorage.getItem("rj-store-ts") || 0)) return;
		if (typeof data.cookies === "string" && data.cookies) await storeWrite(data.cookies);
		if (data.sitestorage && typeof data.sitestorage === "object") {
			for (const [host, entries] of Object.entries(data.sitestorage)) {
				if (!entries || typeof entries !== "object") continue;
				for (const [k, v] of Object.entries(entries)) localStorage.setItem(host + "@" + k, v);
			}
		}
		localStorage.setItem("rj-store-ts", String(ts));
	} catch (err) {}
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
				if (settings.engine === "ddg" && !localStorage.getItem("rj.engine-migrated-v090")) {
					settings.engine = "rj";
					localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
					localStorage.setItem("rj.engine-migrated-v090", "1");
				}
			}
			applyTheme();
			applyCloak();
			applyZoom();
			syncSettingsUI();
			renderBookmarks();
			renderHistory();
			syncStar();
			markSync("synced");
		} else {
			markSync("locked");
		}
		await hydrateStorage();
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
if (settings.restoreTabs !== false) {
	for (const st of savedTabs.tabs || []) {
		if (tabs.length >= 8) break;
		tabs.push({ id: ++tabSeq, frame: null, url: st.url || null, title: st.title || "", page: st.page || null, icon: st.icon || null });
	}
	if (tabs.length) {
		activateTab(tabs[Math.max(0, Math.min(savedTabs.active || 0, tabs.length - 1))]);
	}
}

applyTheme();
applyCloak();
syncSettingsUI();
renderBookmarks();
setStatus("", "idle");document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") scheduleStoragePush(); });
window.addEventListener("pagehide", () => { if (storageSyncOn()) pushStorageNow(); });
setInterval(() => { if (document.visibilityState === "visible") scheduleStoragePush(); }, 5 * 60 * 1000);
hydrateFromServer();
// v0.9.9: deep link - /?u=<url or search> acts exactly like an omnibox submit,
// so external shortcuts can open a target through the proxy in one tap.
try {
	const deepLink = new URLSearchParams(location.search).get("u");
	if (deepLink) {
		history.replaceState(null, "", location.pathname);
		const target = resolveInput(deepLink);
		if (target) ensureReady().then(() => { newTab(); ignite(target); }).catch(() => {});
	}
} catch (err) {}
address.focus();
