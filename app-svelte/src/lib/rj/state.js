// ramjet shared state: settings, themes, engines, cloaks, tabs, bookmarks, history.
// Data layer only - frame/DOM machinery lives in engine.js.
import { writable, get } from "svelte/store";

export const SETTINGS_KEY = "rj.settings";
export const BOOKMARKS_KEY = "rj.bookmarks";
export const HISTORY_KEY = "rj.history";
export const TABS_KEY = "rj.tabs";

export const DEFAULTS = {
	theme: "amber",
	engine: "rj",
	cloak: "off",
	lastCloak: "docs",
	panicKey: "`",
	panicUrl: "https://www.google.com",
	zoom: "100",
	clearOnExit: false,
	clearCookiesOnExit: false,
	lowData: false,
	restoreTabs: true,
	pageMode: "full",
	pageModeExplicit: false,
	customEngineName: "",
	customEngineUrl: "",
};

export const THEMES = {
	amber: ["#ffa028", "#c96f04"],
	mint: ["#34d399", "#059669"],
	sky: ["#38bdf8", "#0369a1"],
	violet: ["#a78bfa", "#6d28d9"],
	ember: ["#f87171", "#b91c1c"],
};

export const ENGINES = {
	rj: ["ramjet search", "/search?q="],
	ddg: ["DuckDuckGo", "https://duckduckgo.com/?q="],
	google: ["Google", "https://www.google.com/search?q="],
	bing: ["Bing", "https://www.bing.com/search?q="],
	brave: ["Brave", "https://search.brave.com/search?q="],
};

const CLOAK_ICON = {
	docs: "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M6 2h8l6 6v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z" fill="#4285f4"/><path d="M14 2l6 6h-6z" fill="#a8c7fa"/><path d="M8 12h8M8 15.5h8M8 19h5" stroke="#fff" stroke-width="1.6" stroke-linecap="round"/></svg>'),
	classroom: "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" rx="4" fill="#1e8e3e"/><circle cx="12" cy="8.6" r="2.7" fill="#fff"/><path d="M5.5 18.8c.9-3.8 3.5-5.7 6.5-5.7s5.6 1.9 6.5 5.7z" fill="#fff"/></svg>'),
	gmail: "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" rx="4" fill="#fff"/><path fill="#ea4335" d="M21.5 6.6v10.8a1.3 1.3 0 0 1-1.3 1.3h-3V11.4L12 15.4l-5.2-4v7.3h-3a1.3 1.3 0 0 1-1.3-1.3V6.6c0-1.6 1.8-2.5 3.1-1.6L12 10l6.4-5c1.3-.9 3.1 0 3.1 1.6z"/></svg>'),
	wiki: "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9.5" fill="#f8f9fa" stroke="#a2a9b1" stroke-width="1"/><path d="M12 2.5c-2.6 2.6-4 5.8-4 9.5s1.4 6.9 4 9.5c2.6-2.6 4-5.8 4-9.5s-1.4-6.9-4-9.5z" fill="none" stroke="#a2a9b1" stroke-width=".9"/><path d="M3.2 9.4h17.6M3.2 14.6h17.6" stroke="#a2a9b1" stroke-width=".9"/></svg>'),
};

export const CLOAKS = {
	off: ["Ramjet - GoatTech", "/assets/ramjet.svg"],
	docs: ["Google Docs", CLOAK_ICON.docs],
	classroom: ["Google Classroom", CLOAK_ICON.classroom],
	gmail: ["Inbox (3) - Gmail", CLOAK_ICON.gmail],
	wiki: ["Wikipedia", CLOAK_ICON.wiki],
};

function load(key, fallback) {
	try { return JSON.parse(localStorage.getItem(key) || "") ?? fallback; } catch (e) { return fallback; }
}

// settings (migrated the same way the old app did)
let s0 = { ...DEFAULTS, ...load(SETTINGS_KEY, {}) };
if (typeof s0.fullPage !== "undefined") { if (s0.fullPage) s0.pageMode = "full"; delete s0.fullPage; }
if (!s0.pageMode) s0.pageMode = "full";
if (s0.engine === "ddg" && !localStorage.getItem("rj.engine-migrated-v090")) {
	s0.engine = "rj";
	localStorage.setItem(SETTINGS_KEY, JSON.stringify(s0));
	localStorage.setItem("rj.engine-migrated-v090", "1");
}

export const settings = writable(s0);
export const bookmarks = writable(load(BOOKMARKS_KEY, []));
export const history = writable(load(HISTORY_KEY, []));
export const tabs = writable([]);        // {id, frame, url, title, icon, page, direct}
export const activeTabId = writable(null);
export const status = writable({ msg: "", mode: "idle" });
export const downloads = writable([]);   // UI snapshots from engine (no chunks/blob/ctrl)
export const meInfo = writable(null);    // /auth/me payload
export const syncState = writable("");   // "synced" | "locked" | "sync off" | "sync failed"

let syncPush = () => {};
export function onSyncPush(fn) { syncPush = fn; }

export function saveSettings(v) {
	settings.set(v);
	try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(v)); } catch (e) {}
	syncPush();
}
export function saveBookmarks(v) {
	bookmarks.set(v);
	try { localStorage.setItem(BOOKMARKS_KEY, JSON.stringify(v)); } catch (e) {}
	syncPush();
}
export function saveHistory(v) {
	history.set(v);
	try { localStorage.setItem(HISTORY_KEY, JSON.stringify(v)); } catch (e) {}
	syncPush();
}

export const isMobile = () => matchMedia("(pointer: coarse)").matches || innerWidth <= 768;
export const lowDataActive = () => !!get(settings).lowData && isMobile();
export const effectivePageMode = () => (get(settings).pageModeExplicit ? get(settings).pageMode || "full" : "embedded");

export function shadeHex(hex, amt) {
	const n = parseInt(hex.slice(1), 16);
	const ch = (v) => Math.max(0, Math.min(255, Math.round(v * (1 + amt))));
	return "#" + [ch(n >> 16), ch((n >> 8) & 255), ch(n & 255)].map((v) => v.toString(16).padStart(2, "0")).join("");
}
export function accentColors() {
	const s = get(settings);
	if (s.theme === "custom") {
		const amber = s.customAccent || "#ffa028";
		return [amber, shadeHex(amber, -0.35)];
	}
	return THEMES[s.theme] || THEMES.amber;
}
export function faviconSvg(amber, deep) {
	return "data:image/svg+xml," + encodeURIComponent(
		'<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">' +
		'<path fill="' + amber + '" d="M11.6 39.6 L14.4 42.4 L4.7 50.7 L3.3 49.3 Z"/>' +
		'<path fill="' + amber + '" d="M20.6 48.6 L23.4 51.4 L15.7 57.7 L14.3 56.3 Z"/>' +
		'<path fill="' + deep + '" d="M58 6 L12 22 L30 32 Z"/>' +
		'<path fill="' + amber + '" d="M58 6 L30 32 L40 50 Z"/></svg>');
}
export function applyTheme() {
	const [amber, deep] = accentColors();
	document.documentElement.style.setProperty("--amber", amber);
	document.documentElement.style.setProperty("--amber-deep", deep);
	const favicon = document.querySelector('link[rel="icon"]');
	if (favicon && get(settings).cloak === "off") favicon.href = faviconSvg(amber, deep);
}
export function applyCloak() {
	const s = get(settings);
	const key = CLOAKS[s.cloak] ? s.cloak : "off";
	document.title = CLOAKS[key][0];
	let link = document.querySelector('link[rel="icon"]');
	if (!link) { link = document.createElement("link"); link.rel = "icon"; document.head.appendChild(link); }
	link.href = key === "off" ? faviconSvg(...accentColors()) : CLOAKS[key][1];
}
export function setStatus(msg, mode) { status.set({ msg, mode: mode || "idle" }); }
