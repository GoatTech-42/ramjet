// ramjet proxy core - ported near-verbatim from the legacy app.js for feature
// fidelity. UI seams (renderTabs, setStatus, syncBar, ignite's DOM touches) route
// through bridge.js; data seams (settings, tabs, activeTab) through state.js.
import {
	settings as settingsStore, bookmarks as bookmarksStore, history as historyStore,
	tabs as tabsStore, activeTabId as activeTabIdStore,
	setStatus,
	isMobile, lowDataActive, effectivePageMode, ENGINES,
	downloads as downloadsStore,
} from "./state.js";
import { get } from "svelte/store";
import * as bridge from "./bridge.js";

let settings = get(settingsStore);
settingsStore.subscribe((v) => (settings = v));
let bookmarks = get(bookmarksStore);
bookmarksStore.subscribe((v) => (bookmarks = v));
let history = get(historyStore);
historyStore.subscribe((v) => (history = v));

const SETTINGS_KEY = "rj.settings", BOOKMARKS_KEY = "rj.bookmarks", HISTORY_KEY = "rj.history";
function saveSettings() { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) {} settingsStore.set({ ...settings }); bridge.scheduleSyncPush(); }
function saveBookmarks() { try { localStorage.setItem(BOOKMARKS_KEY, JSON.stringify(bookmarks)); } catch (e) {} bookmarksStore.set([...bookmarks]); bridge.scheduleSyncPush(); }
let tabs = get(tabsStore);
let activeTab = null;
activeTabIdStore.subscribe((id) => { activeTab = tabs.find((t) => t.id === id) || null; });
function syncTabs() { tabsStore.set([...tabs]); }
function setActiveTab(tab) { activeTab = tab; activeTabIdStore.set(tab ? tab.id : null); }

let engine = null;
const scheduleSyncPush = () => bridge.scheduleSyncPush();
const scheduleStoragePush = () => bridge.scheduleStoragePush();
const storageSyncOn = () => bridge.storageSyncOn();
const markSync = (...a) => bridge.markSync(...a);
const HISTORY_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 90;
const renderTabs = () => bridge.renderTabs();
const renderDlBadge = () => bridge.renderDlBadge();
const DL_PAINT_MS = 250;
let dlPushT = null;
function dlSnapshot() {
	return downloads.map((d) => ({
		id: d.id, url: d.url, name: d.name, size: d.size, mime: d.mime,
		state: d.state, error: d.error || null, received: d.received,
		started: d.started, finished: d.finished || null,
	}));
}
function pushDl() { downloadsStore.set(dlSnapshot()); }
function renderDownloads() { pushDl(); }
const hideSuggest = () => bridge.hideSuggest();
const renderSuggest = (...a) => bridge.renderSuggest(...a);
const syncStar = (...a) => bridge.call("syncStar", ...a);
function applyZoom() {
	for (const t of tabs) {
		if (t.frame) t.frame.frame.style.zoom = settings.zoom + "%";
	}
}
const openMenu = (...a) => bridge.openMenu(...a);
const frameHost = new Proxy({}, { get: (_, p) => { const el = bridge.els.frameHost; if (!el) return undefined; const v = el[p]; return typeof v === "function" ? v.bind(el) : v; } });
const address = new Proxy({}, { get: (_, p) => { const el = bridge.els.address; if (!el) return undefined; const v = el[p]; return typeof v === "function" ? v.bind(el) : v; }, set: (_, p, val) => { const el = bridge.els.address; if (el) el[p] = val; return true; } });
let swReady = null;
let tabSeq = 0;

function newTab(url) {
	const tab = { id: ++tabSeq, frame: null, url: url || null, title: url ? "" : "", page: null };
	tabs.push(tab);
	setActiveTab(tab);
	syncTabs();
	return tab;
}
function newPageTab(page) {
	const existing = tabs.find((t) => t.page === page);
	if (existing) { setActiveTab(existing); syncTabs(); return existing; }
	const tab = { id: ++tabSeq, frame: null, url: null, title: "", page };
	tabs.push(tab);
	setActiveTab(tab);
	syncTabs();
	return tab;
}
function closeTab(tab) {
	const i = tabs.indexOf(tab);
	if (i < 0) return;
	tabs.splice(i, 1);
	try { if (tab.frame) tab.frame.frame.remove(); } catch (e) {}
	if (activeTab === tab) setActiveTab(tabs[Math.max(0, i - 1)] || null);
	syncTabs();
}
// UI seams handled by bridge: renderTabs, syncBar, renderDlBadge, renderDownloads,
// openSwitcher, closeSwitcher, openMenu, hideMenu, openFind, hideFind, renderSuggest,
// hideSuggest, renderHistory, renderHistoryPage, openSettings, applyZoom, fitAllFrames hook.

window.addEventListener("resize", () => { try { fitAllFrames(); } catch (e) {} });
window.addEventListener("orientationchange", () => setTimeout(() => { try { fitAllFrames(); } catch (e) {} }, 300));


// ===== frame fit + factory =====
function resetFrameFit(ifr) {
	if (!ifr.dataset.rjFitW) return;
	ifr.style.width = "";
	ifr.style.height = "";
	ifr.style.transform = "";
	ifr.style.transformOrigin = "";
	delete ifr.dataset.rjFitW;
}

function fitFrameToScreen(ifr) {
	if (!isMobile()) { resetFrameFit(ifr); return; }
	if (!ifr.parentElement) return;
	let doc;
	try { doc = ifr.contentDocument; } catch (err) { return; }
	if (!doc || !doc.documentElement) return;
	const hostW = ifr.parentElement.clientWidth;
	const hostH = ifr.parentElement.clientHeight;
	if (!hostW || !hostH) return;
	const needW = Math.max(doc.documentElement.scrollWidth, doc.body ? doc.body.scrollWidth : 0);
	if (needW <= hostW + 4) { resetFrameFit(ifr); return; }
	if (ifr.dataset.rjFitW && Math.abs(needW - Number(ifr.dataset.rjFitW)) <= 8) return;
	const s = hostW / needW;
	ifr.style.width = needW + "px";
	ifr.style.height = Math.ceil(hostH / s) + "px";
	ifr.style.transform = "scale(" + s + ")";
	ifr.style.transformOrigin = "top left";
	ifr.dataset.rjFitW = String(needW);
}

function fitAllFrames() {
	for (const t of tabs) {
		if (t.frame && t.frame.frame) fitFrameToScreen(t.frame.frame);
	}
}

function scheduleFit(ifr) {
	fitFrameToScreen(ifr);
	setTimeout(() => fitFrameToScreen(ifr), 600);
	setTimeout(() => fitFrameToScreen(ifr), 1800);
	setTimeout(() => fitFrameToScreen(ifr), 4000);
	// pages keep settling after load (SPAs, late media) - keep re-checking on DOM changes, debounced
	clearTimeout(ifr._rjFitWatch);
	ifr._rjFitWatch = setTimeout(() => {
		let doc;
		try { doc = ifr.contentDocument; } catch (err) { return; }
		if (!doc || !doc.documentElement) return;
		let deb = 0;
		const mo = new MutationObserver(() => {
			clearTimeout(deb);
			deb = setTimeout(() => fitFrameToScreen(ifr), 500);
		});
		mo.observe(doc.documentElement, { childList: true, subtree: true });
	}, 4500);
}

window.addEventListener("resize", fitAllFrames);
window.addEventListener("orientationchange", () => setTimeout(fitAllFrames, 300));

function ensureFrame(tab) {
	if (tab.frame) return tab.frame;
	const f = engine.createFrame();
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
		try { if (lowDataActive()) installLowData(f.frame.contentDocument); } catch (err) {}
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
		resetFrameFit(f.frame); // v1.0.7: fresh page = fresh measurement, no stale fit from the previous page
		scheduleFit(f.frame);
	});
	frameHost.appendChild(f.frame);
	tab.frame = f;
	return f;
}


// ===== downloads =====
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
	if (dlPushT) return;
	dlPushT = setTimeout(() => { dlPushT = null; pushDl(); }, DL_PAINT_MS);
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


function openDownloads() { newPageTab("downloads"); }
(document.getElementById("w1da0eb") || bridge.nullEl).addEventListener("click", openDownloads);
(document.getElementById("w768066") || bridge.nullEl).addEventListener("click", openDownloads);
(document.getElementById("w87e0c0") || bridge.nullEl).addEventListener("click", () => { if (activeTab && activeTab.page) closeTab(activeTab); });
(document.getElementById("w58fc1a") || bridge.nullEl).addEventListener("click", () => {
	for (const d of [...downloads]) if (d.state !== "downloading") dlForget(d);
	renderDownloads();
});
renderDlBadge();


// ===== low data =====
// -- low data mode (mobile only) ---------------------------------------------
// Luke 9/25: basic mode only - lazy images, no autoplay, no media preload, no
// prefetch/preload hints. Save-Data header is impossible here: outbound fetch
// runs client-side in the libcurl-wasm transport (server is a dumb TCP relay).


// Luke 9/25: "only do the popup if u have to" - same-tab embedded is the
// default EVERYWHERE. Popups (full / fullbare) fire only through the fallback
// chain when embedded actually fails, or when he explicitly picks a mode in
// settings. Tradeoff he accepted: framed proxy content is the thing school
// filters can block, so on a filtered network the first navigation may take
// one failed embedded attempt before the popup fallback kicks in.

function lowDataPatchNode(root) {
	if (!root) return;
	const q = (sel, fn) => {
		try {
			if (root.matches && root.matches(sel)) fn(root);
			if (root.querySelectorAll) root.querySelectorAll(sel).forEach(fn);
		} catch (e) {}
	};
	q("img", (im) => { if (!im.getAttribute("loading")) im.setAttribute("loading", "lazy"); });
	q("video,audio", (m) => {
		m.setAttribute("preload", "none");
		if (m.hasAttribute("autoplay")) { m.removeAttribute("autoplay"); try { m.pause(); } catch (e) {} }
	});
	q('link[rel="prefetch"],link[rel="preload"]', (l) => l.remove());
}

function installLowData(doc) {
	if (!doc || !doc.documentElement || doc.__rjLowData) return;
	doc.__rjLowData = true;
	lowDataPatchNode(doc.documentElement);
	const MO = (doc.defaultView || window).MutationObserver;
	if (!MO) return;
	const mo = new MO((muts) => {
		if (!lowDataActive()) return;
		for (const m of muts) {
			for (const n of m.addedNodes) if (n.nodeType === 1) lowDataPatchNode(n);
		}
	});
	mo.observe(doc.documentElement, { childList: true, subtree: true });
}

function applyLowDataState() {
	const navBtn = (document.getElementById("w5d2c9e") || bridge.nullEl);
	if (navBtn) navBtn.hidden = !isMobile();
	if (lowDataActive()) {
		for (const t of tabs) {
			if (t.frame) { try { installLowData(t.frame.frame.contentDocument); } catch (e) {} }
		}
		for (const rec of POPUPS) {
			try { installLowData(rec.win.document); } catch (e) {}
		}
	}
}


// ===== history record =====
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

// ===== engine bootstrap =====

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
			const { default: LibcurlClient } = await import(/* @vite-ignore */ "/libcurl/index.mjs");
			const transport = new LibcurlClient({ wisp: wispUrl });
			const controller = new $wkcore.Controller({
				serviceworker: readySw,
				transport,
				engineConfig: $wkcfg.defaultConfig,
				prefix: "/view/",
				enginePath: "/lib/core.js",
				injectPath: "/lib/inject.js",
				wasmPath: "/lib/core.wasm",
				virtualWasmPath: "core.wasm.js",
			});
			window.__goc = controller;
			await controller.wait();
			engine = {
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

// ===== error surfaces =====
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
		"<button class=\"back\" onclick=\"history.back()\">go back</button>" +
		(real ? "<button class=\"back\" onclick=\"parent.__gop(" + JSON.stringify(real).replace(/"/g, "&quot;") + ")\">open full-page</button>" : "") +
		"</div>" +
		"</div></body></html>";
}

function rjHookFrameErrors(fr) {
	try {
		$wkcfg.Tap.tap(fr.hooks.error.request, async (ctx, props) => {
			try {
				const dest = ctx.rawrequest && ctx.rawrequest.destination;
				if (dest && dest !== "document" && dest !== "iframe") return;
				props.suppressError = true;
				const rawUrl = ctx.rawrequest ? ctx.rawrequest.rawUrl : "";
				if (rawUrl && rjAutoFallback(rawUrl, "embedded")) {
					props.setResponse = {
						body: "<!doctype html><html><body style=\"margin:0;background:#0b0c0e\"></body></html>",
						status: 200,
						statusText: "OK",
						headers: [["content-type", "text/html; charset=utf-8"]],
					};
					return;
				}
				props.setResponse = {
					body: rjErrorPageHtml(rawUrl, ctx.error),
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
				if (realUrl && rjAutoFallback(realUrl, "embedded")) return;
				setStatus("couldn't load in any browsing mode", "error");
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
					else if (el.__rjLast) rjModeTries.delete(rjRealUrl(el.__rjLast));
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
		$wkcfg.Tap.tap(fr.hooks.fetch, (ctx) => {
			try {
				const dest = ctx && ctx.rawrequest && ctx.rawrequest.destination;
				if (dest !== "document" && dest !== "iframe") return;
				arm((ctx.rawrequest && ctx.rawrequest.rawUrl) || "");
			} catch (e) {}
		});
	} catch (e) {}
}

// turns whatever was typed into a real url (or a search)

// ===== nav =====
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
		if (u.pathname.startsWith("/view/") && isOwnOrigin(u.origin)) {
			// proxied URL stamped with another origin - recover the destination
			const seg = u.pathname.slice("/view/".length).split("/").filter(Boolean).pop();
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
	url = normalizeUrl(url);
	if (url.startsWith(location.origin + "/")) url = url.slice(location.origin.length);
	// v0.10.5: full-page mode - proxied pages open TOP-LEVEL in a new browser tab
	// (no iframe anywhere) so filters that block framed proxy content never see an
	// embed. The app tab must stay open: it owns the engine's transport.
	if (effectivePageMode() !== "embedded" && !(url.startsWith("/searx/") || url.startsWith("/search"))) {
		// v0.10.6: full-page modes open proxied pages TOP-LEVEL (no iframe for a
		// filter to block). "full" injects the ramjet bar into the popped page.
		const src = rjEncodeDest(url);
		const w = window.open(src, "_blank");
		if (w) {
			rjWatchPopup(w, src, url, effectivePageMode());
			recordHistory(url, null);
			setStatus("opened full-page - keep this tab open", "idle");
			return;
		}
		// popup blocked: fall back to embedded for this navigation
		setStatus("popups blocked - opened here instead", "busy");
	}
	if (!activeTab) newTab();
	const tab = activeTab;
	const f = ensureFrame(tab);
	if (url.startsWith("/searx/") || url.startsWith("/search")) {
		// same-origin search: no engine wrap - the frame's own session cookie
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

// v0.10.6: encode a real destination into its /view/ proxied URL without
// loading it (scratch frame, discarded immediately).
function rjEncodeDest(url) {
	const scratch = engine.createFrame();
	scratch.go(url);
	const src = scratch.frame.src;
	try { scratch.frame.remove(); } catch (err) {}
	return src;
}
// v0.10.6: auto mode fallback (Luke, 9/25): when a browsing mode fails, cycle
// the remaining modes until one loads; the error page only shows after every
// mode has failed for that URL.
const RJ_MODE_ORDER = ["embedded", "full", "fullbare"];
const rjModeTries = new Map();
function rjRealUrl(rawUrl) {
	let real = String(rawUrl || "");
	try {
		const u = new URL(real, location.origin);
		if (u.pathname.includes("/view/")) {
			const seg = u.pathname.split("/").filter(Boolean).pop();
			const dec = decodeURIComponent(seg || "");
			if (/^https?:/.test(dec)) return dec;
		}
	} catch (e) {}
	return real;
}
function rjAutoFallback(rawUrl, failedMode) {
	const realUrl = rjRealUrl(rawUrl);
	if (!/^https?:/.test(realUrl)) return false;
	if (rjModeTries.size > 200) rjModeTries.clear();
	let rec = rjModeTries.get(realUrl);
	if (!rec || Date.now() - rec.ts > 60000) { rec = { tried: new Set(), ts: Date.now() }; rjModeTries.set(realUrl, rec); }
	rec.ts = Date.now();
	rec.tried.add(failedMode);
	const next = RJ_MODE_ORDER.find((m) => !rec.tried.has(m));
	if (!next) return false; // entry stays: repeat failures inside the window error fast
	rec.tried.add(next); // the escalation attempt counts as a try - this is what stops re-fires from re-opening the same mode forever
	setStatus("that mode failed - trying " + (next === "embedded" ? "in the app" : next === "full" ? "full-page" : "full-page without the bar"), "busy");
	if (next === "embedded") {
		if (!activeTab) newTab();
		const tab = activeTab;
		const f = ensureFrame(tab);
		tab.direct = false;
		f.go(realUrl);
		tab.url = realUrl;
		if (!tab.title) { try { tab.title = new URL(realUrl).hostname; } catch (e) {} }
		document.body.classList.add("in-flight");
		f.frame.style.display = "block";
		renderTabs();
		return true;
	}
	try {
		const src = rjEncodeDest(realUrl);
		const w = window.open(src, "_blank");
		if (w) {
			rjWatchPopup(w, src, realUrl, next);
			recordHistory(realUrl, null);
			return true;
		}
	} catch (e) {}
	return rjAutoFallback(realUrl, next); // popup blocked: count the mode and move on
}

// bridge for error pages (same-origin frames/popups): pop a failed URL out full-page.
window.__gop = (url) => {
	try {
		const src = rjEncodeDest(url);
		const w = window.open(src, "_blank");
		if (!w) { setStatus("popups blocked - allow popups for full-page", "error"); return; }
		rjWatchPopup(w, src, url, effectivePageMode() === "fullbare" ? "fullbare" : "full");
	} catch (err) {}
};

function peelProxied(href) {
	// v2 URL shape: /view/<scramtag>/<codec>/<encodeURIComponent(realUrl)>
	const prefix = location.origin + "/view/";
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
		if (real === href && href.includes("/view/")) return; // still mid-redirect
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


// ===== suggest =====

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

// ===== popup watch =====
// -- v0.10.6: full-page bar ---------------------------------------------------
// The popped-out page is same-origin (it rides this origin's /view/ path), so
// the app tab can inject the ramjet bar straight into its document - no iframe
// anywhere, filters see only a plain top-level page. The watcher re-injects on
// every navigation and records history from the popup's real URLs.
const POPUPS = new Set();
function rjWatchPopup(w, initialHref, realUrl, mode) {
	POPUPS.add({ win: w, href: initialHref, realUrl: realUrl || peelProxied(initialHref), mode: mode || "full", openedAt: Date.now(), dark: 0 });
}
setInterval(() => {
	for (const rec of POPUPS) {
		const w = rec.win;
		if (!w || w.closed) { POPUPS.delete(rec); continue; }
		let href = null, doc = null;
		try { href = w.location.href; doc = w.document; } catch (err) { href = null; }
		if (href === null) {
			// chrome-error pages are cross-origin to us: sustained inaccessibility
			// after the load should have committed means this mode failed
			if (rec.realUrl && Date.now() - rec.openedAt > 4000 && ++rec.dark >= 4) {
				POPUPS.delete(rec);
				try { w.close(); } catch (e) {}
				if (!rjAutoFallback(rec.realUrl, rec.mode)) {
					// every mode failed - show the error in the app tab
					try {
						if (!activeTab) newTab();
						const tab = activeTab;
						const f = ensureFrame(tab);
						tab.direct = false;
						tab.url = rec.realUrl;
						let html = rjErrorPageHtml(rec.realUrl, new Error("all browsing modes failed"));
						let retry = "";
						try { retry = f.frame.getAttribute("src") || ""; } catch (e2) {}
						if (retry) html = html.replace('onclick="location.reload()"', 'onclick="location.replace(' + JSON.stringify(retry).replace(/"/g, "&quot;") + ')"');
						f.frame.srcdoc = html;
						f.frame.style.display = "block";
						setStatus("couldn't load in any browsing mode", "error");
						renderTabs();
					} catch (e3) {}
				}
			}
			continue;
		}
		if (!href || href === "about:blank" || !doc || !doc.body) continue;
		rec.dark = 0;
		// note: an accessible doc is NOT success here - the engine serves its own
		// error UI with a 200, so only the 60s try-window expires failures
		if (href !== rec.href) {
			rec.href = href;
			recordHistory(peelProxied(href), null);
		}
		const ours = href.includes("/view/") || href.startsWith(location.origin + "/search") || href.startsWith(location.origin + "/searx");
		if (!ours) continue;
		// low data mode: patch every proxied popup doc, any browsing mode. rec.href
		// tracks navigations; a fresh document gets a fresh install (marker expando
		// is per-document) and its MutationObserver dies with the old doc.
		if (lowDataActive() && rec.lowDataHref !== href) {
			rec.lowDataHref = href;
			try { installLowData(doc); } catch (e) {}
		}
		if (rec.mode !== "full") continue; // the bar rides full-page+bar mode only
		if (!doc.getElementById("w92f603")) injectPopBar(w, href);
		else syncPopBar(w, href);
	}
}, 700);

function injectPopBar(w, href) {
	const doc = w.document;
	const [amber, deep] = accentColors();
	const style = doc.createElement("style");
	style.id = "wdda035";
	// v0.11.x (Luke, 9/25): shell-matching look - rounded omnibox, panel tones,
	// amber accents - still fully self-contained so the proxied page's own CSS
	// can't break it and ours can't leak into it.
	style.textContent =
		"#w92f603{position:fixed;top:0;left:0;right:0;height:44px;z-index:2147483647;display:flex;align-items:center;gap:8px;padding:0 10px;background:#171310;border-bottom:1px solid #2a2119;font:13.5px system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;box-sizing:border-box;box-shadow:0 1px 8px rgba(0,0,0,.35)}" +
		"#w92f603 button{background:transparent;border:1px solid #2a2119;color:" + amber + ";border-radius:9px;min-width:30px;height:30px;padding:0 9px;font:14px system-ui;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;transition:background 120ms ease,border-color 120ms ease}" +
		"#w92f603 button:hover{background:#241d14;border-color:#3a2e1e}" +
		"#w92f603 input{flex:1;min-width:40px;height:32px;background:#0f0c09;border:1px solid #2a2119;border-radius:10px;color:#f5ead6;padding:0 12px;font:13.5px system-ui;outline:0;transition:border-color 120ms ease,box-shadow 120ms ease}" +
		"#w92f603 input:focus{border-color:" + deep + ";box-shadow:0 0 0 3px " + amber + "21}" +
		"#w92f603 button.wb-home{background:" + amber + ";border-color:" + amber + ";color:#14100a;font-weight:700;font-size:12.5px;letter-spacing:.02em;border-radius:10px;padding:0 13px}" +
		"#w92f603 button.wb-home:hover{background:" + amber + ";filter:brightness(1.08)}";
	(doc.head || doc.documentElement).appendChild(style);
	const bar = doc.createElement("div");
	bar.id = "w92f603";
	const mk = (label, fn) => {
		const b = doc.createElement("button");
		b.type = "button";
		b.textContent = label;
		b.addEventListener("click", (e) => { e.preventDefault(); fn(); });
		return b;
	};
	bar.appendChild(mk("\u2039", () => w.history.back()));
	bar.appendChild(mk("\u203a", () => w.history.forward()));
	const omni = doc.createElement("input");
	omni.id = "w38c00e";
	omni.spellcheck = false;
	omni.value = peelProxied(href);
	omni.addEventListener("keydown", (e) => {
		if (e.key !== "Enter") return;
		e.preventDefault();
		try {
			const dest = resolveInput(omni.value);
			if (!dest) return;
			if (dest.startsWith("/search") || dest.startsWith("/searx")) w.location.href = location.origin + dest;
			else w.location.href = rjEncodeDest(dest);
		} catch (err) {}
	});
	bar.appendChild(omni);
	const homeBtn = mk("ramjet", () => { try { window.focus(); } catch (err) {} });
	homeBtn.className = "wb-home";
	bar.appendChild(homeBtn);
	doc.body.appendChild(bar);
}

function syncPopBar(w, href) {
	try {
		const omni = (w.document.getElementById("w38c00e") || bridge.nullEl);
		if (omni && w.document.activeElement !== omni) omni.value = peelProxied(href);
	} catch (err) {}
}

// settings toggles, close-time wipe and storage sync live in sync.js now -
// the Svelte settings view writes settings through the store, and sync.js owns
// the wipe/tombstone system end to end.



// ===== frame doc wiring =====
// -- in-page controls: ctrl/cmd+click and middle-click open tabs, custom right-click menu --
function decodeProxied(href) {
	const prefix = location.origin + "/view/";
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
	// v1.0.5 (Luke): never let an embedded page escape into a bare browser tab.
	// A bare /view/ tab has no app shell around it - once the app tab moves on
	// the controller has no live frame for that prefix, and there is no watcher
	// or mode fallback - so sites (YouTube) that force target=_blank/window.open
	// landed in a broken tab even though the same page browses fine embedded.
	doc.addEventListener("click", (e) => {
		if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
		const a = linkAt(e);
		if (!a) return;
		const tgt = (a.getAttribute("target") || "").toLowerCase();
		if (!tgt || tgt === "_self") return; // named targets open a new browsing context too
		e.preventDefault();
		e.stopPropagation();
		try { f.frame.contentWindow.location.href = a.href; } catch (err) { f.frame.src = a.href; }
	}, true);
	// window.open from page scripts gets the same treatment: a working new tab
	// inside ramjet (keeps the shell) instead of a broken bare browser tab.
	try {
		const cw = f.frame.contentWindow;
		cw.open = function (url, target, feats) {
			try {
				const abs = new URL(String(url || ""), cw.location.href).href;
				const dest = decodeProxied(abs);
				if (/^https?:/i.test(dest)) { newTab(dest); return null; }
			} catch (err) {}
			return null;
		};
	} catch (err) {}
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

const menu = (document.getElementById("w3cebd0") || bridge.nullEl);

// exports for the Svelte shell
function dlClearFinished() {
	for (const d of [...downloads]) if (d.state !== "downloading") dlForget(d);
}
function popOutFullPage() {
	let target = null;
	for (let i = tabs.length - 1; i >= 0; i--) {
		if (tabs[i].frame && tabs[i].frame.frame && tabs[i].frame.frame.src) { target = tabs[i]; break; }
	}
	if (!target) { setStatus("open a site first", "error"); return; }
	const src = target.frame.frame.src;
	if (!src || src === "about:blank") return;
	const w = window.open(src, "_blank");
	if (!w) setStatus("popups blocked - allow popups for full-page", "error");
	else {
		rjWatchPopup(w, src, peelProxied(src), effectivePageMode() === "fullbare" ? "fullbare" : "full");
		setStatus("opened full-page - keep this tab open", "idle");
	}
}
// sync.js hydration seam: apply a server-pulled blob to local data + stores.
function acceptSyncData(data) {
	if (!data) return;
	if (Array.isArray(data.history)) {
		history = data.history.slice(0, 200);
		try { localStorage.setItem(HISTORY_KEY, JSON.stringify(history)); } catch (e) {}
		historyStore.set([...history]);
	}
	if (Array.isArray(data.bookmarks)) {
		bookmarks = data.bookmarks.slice(0, 100);
		try { localStorage.setItem(BOOKMARKS_KEY, JSON.stringify(bookmarks)); } catch (e) {}
		bookmarksStore.set([...bookmarks]);
	}
	if (data.settings && typeof data.settings === "object") {
		const next = { ...settings, ...data.settings };
		try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(next)); } catch (e) {}
		settingsStore.set(next);
	}
	applyZoom();
}
pushDl();
export {
	engine, newTab, newPageTab, closeTab, ensureFrame, ignite, resolveInput,
	fitAllFrames, scheduleFit, ensureReady, setActiveTab, syncTabs,
	dlPause, dlResume, dlForget, dlSave, dlOpenTab, dlClearFinished,
	popOutFullPage, applyZoom, acceptSyncData,
};
