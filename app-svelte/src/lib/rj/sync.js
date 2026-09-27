// ramjet sync + account layer - ported from legacy app.js.
// Owns: encrypted settings/history/bookmarks sync (RJCrypto blob), site-storage
// sync (admin-gated), the close-time wipe + tombstone guarantee, /auth/me state,
// and account/admin API wrappers for the settings views.
import { get } from "svelte/store";
import {
	settings as settingsStore, history as historyStore,
	meInfo as meInfoStore, syncState as syncStateStore,
	applyTheme, applyCloak,
} from "./state.js";
import * as bridge from "./bridge.js";
import { acceptSyncData, applyZoom } from "./engine.js";

const HISTORY_KEY = "rj.history";
const TABS_KEY = "rj.tabs";

const RC = () => (typeof RJCrypto !== "undefined" ? RJCrypto : null);
let meInfo = null;
meInfoStore.subscribe((v) => (meInfo = v));
function setMe(v) { meInfo = v; meInfoStore.set(v); }

function markSync(txt) { syncStateStore.set(txt); }

// -- settings/history/bookmarks sync ------------------------------------------
let syncTimer = null;
function scheduleSyncPush() {
	const rc = RC();
	if (!rc || !rc.unlocked()) return;
	clearTimeout(syncTimer);
	syncTimer = setTimeout(async () => {
		try {
			const cur = (await rc.pull()) || {};
			cur.history = get(historyStore).slice(0, 200);
			cur.bookmarks = JSON.parse(localStorage.getItem("rj.bookmarks") || "[]").slice(0, 100);
			cur.settings = get(settingsStore);
			await rc.push(cur);
			markSync("synced");
		} catch (err) { markSync("sync failed"); }
	}, 800);
}

// -- storage sync (admin-gated): site logins follow the account ---------------
const STORE_DB = "__wk_store", STORE_STORE = "state", STORE_KEY = "cookies";
const STORE_CHAN = "__wk_channel";
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
	const rc = RC();
	return !!(rc && rc.unlocked() && meInfo && meInfo.syncEnabled);
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
		if (!/^[a-z0-9.-]+(:\d+)?$/i.test(host)) continue;
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
		const ok = await RC().pushStorage({ cookies, sitestorage: sites, syncedAt: Date.now() });
		if (ok) { localStorage.setItem("rj-store-ts", String(Date.now())); markSync("synced"); }
	} catch (err) {}
}
async function jarMutate(fn) {
	const state = await storeRead();
	let jar = {};
	try { jar = state && state.cookies ? JSON.parse(state.cookies) : {}; } catch (err) {}
	fn(jar);
	await storeWrite(JSON.stringify(jar));
	scheduleStoragePush();
}
async function hydrateStorage() {
	const rc = RC();
	if (!meInfo || !meInfo.syncEnabled || !rc || !rc.unlocked()) return;
	try {
		const data = await rc.pullStorage();
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

// -- site storage view data -----------------------------------------------------
async function getSiteStorageData() {
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
	return Object.keys(bySite).sort().map((host) => {
		const info = bySite[host];
		const lsBytes = Object.entries(info.storage).reduce((n, [k, v]) => n + k.length + String(v).length, 0);
		const cBytes = info.cookies.reduce((n, c) => n + (c.name || "").length + (c.value || "").length, 0);
		info.cookies.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
		return { host, cookies: info.cookies, storage: info.storage, kb: ((lsBytes + cBytes) / 1024).toFixed(1) };
	});
}
async function clearSiteStorageHost(host) {
	await jarMutate((j) => {
		for (const [id, c] of Object.entries(j)) {
			if (((c.domain || "").replace(/^\./, "")) === host) delete j[id];
		}
	});
	const doomed = [];
	for (let i = 0; i < localStorage.length; i++) {
		const k = localStorage.key(i);
		if (k && k.startsWith(host + "@")) doomed.push(k);
	}
	for (const k of doomed) localStorage.removeItem(k);
	scheduleStoragePush();
}
async function clearAllSiteStorage() {
	await storeWrite("{}");
	for (const [host, entries] of Object.entries(collectSiteStorage())) {
		for (const k of Object.keys(entries)) localStorage.removeItem(host + "@" + k);
	}
	scheduleStoragePush();
}
async function setCookieValue(id, value) { await jarMutate((j) => { if (j[id]) j[id].value = value; }); }
async function deleteCookie(id) { await jarMutate((j) => { delete j[id]; }); }
function setSiteKey(host, k, v) { localStorage.setItem(host + "@" + k, v); scheduleStoragePush(); }
function delSiteKey(host, k) { localStorage.removeItem(host + "@" + k); scheduleStoragePush(); }

// -- hydrate from server --------------------------------------------------------
async function hydrateFromServer() {
	try {
		const meRes = await fetch("/auth/me");
		if (!meRes.ok) { setMe(null); return; }
		setMe(await meRes.json());
		const rc = RC();
		if (rc && rc.unlocked()) {
			const data = await rc.pull();
			if (data) {
				acceptSyncData(data);
				applyTheme();
				applyCloak();
				applyZoom();
				markSync("synced");
			} else {
				markSync("locked");
			}
		} else {
			markSync(meInfo && meInfo.syncEnabled ? "locked" : "");
		}
		await hydrateStorage();
	} catch (err) {}
}

// -- close-time wipe + tombstone guarantee (v1.0.3/v1.0.8, ported) -------------
function clearSiteStorageKeys() {
	const doomed = [];
	for (let i = 0; i < localStorage.length; i++) {
		const k = localStorage.key(i);
		if (k && k.indexOf("@") > 0) doomed.push(k);
	}
	for (const k of doomed) localStorage.removeItem(k);
}
async function doLocalWipe() {
	const s = get(settingsStore);
	if (s.clearOnExit) {
		historyStore.set([]);
		localStorage.removeItem(HISTORY_KEY);
		localStorage.removeItem(TABS_KEY);
	}
	if (s.clearCookiesOnExit) {
		clearSiteStorageKeys();
		try { await storeWrite("{}"); } catch (err) {}
	}
	scheduleSyncPush();
	if (storageSyncOn()) pushStorageNow();
}
async function runClearOnExit() {
	const s = get(settingsStore);
	if (s.clearOnExit) {
		historyStore.set([]);
		localStorage.removeItem(HISTORY_KEY);
		const rc = RC();
		try {
			if (rc && rc.unlocked()) {
				const cur = (await rc.pull()) || {};
				cur.history = [];
				cur.bookmarks = JSON.parse(localStorage.getItem("rj.bookmarks") || "[]").slice(0, 100);
				cur.settings = s;
				await rc.push(cur);
			}
		} catch (err) {}
	}
	if (s.clearCookiesOnExit) {
		try { await storeWrite("{}"); } catch (err) {}
		try { if (storageSyncOn()) await pushStorageNow(); } catch (err) {}
	}
}
function enforceClearOnExitBoot() {
	const s = get(settingsStore);
	if (s.clearOnExit && get(historyStore).length) {
		historyStore.set([]);
		localStorage.removeItem(HISTORY_KEY);
		scheduleSyncPush();
	}
	if (s.clearCookiesOnExit) {
		storeRead().then((st) => {
			if (st && st.cookies && st.cookies !== "{}") storeWrite("{}").then(() => { if (storageSyncOn()) pushStorageNow(); });
		}).catch(() => {});
	}
}
let rjWipeAck = Number(localStorage.getItem("rj-wipe-ack") || 0);
async function checkWipeTombstone() {
	const s = get(settingsStore);
	if (!s.clearOnExit && !s.clearCookiesOnExit) return;
	try {
		const res = await fetch("/auth/wipe-status", { credentials: "same-origin" });
		if (!res.ok) return;
		const j = await res.json();
		const at = j && j.wipeAt ? Number(j.wipeAt) : 0;
		if (at > rjWipeAck) {
			rjWipeAck = at;
			localStorage.setItem("rj-wipe-ack", String(at));
			await doLocalWipe();
		}
	} catch (err) {}
}

let wipeWired = false;
function wireWipe() {
	if (wipeWired) return;
	wipeWired = true;
	window.addEventListener("pagehide", () => {
		const s = get(settingsStore);
		if (s.clearOnExit) {
			historyStore.set([]);
			localStorage.removeItem(HISTORY_KEY);
			localStorage.removeItem(TABS_KEY);
		}
		if (s.clearCookiesOnExit) clearSiteStorageKeys();
		if (s.clearOnExit || s.clearCookiesOnExit) {
			try { navigator.sendBeacon("/auth/wipe-on-close", "1"); } catch (err) {}
			try { new BroadcastChannel("rj-wipe").postMessage({ at: Date.now() }); } catch (err) {}
			runClearOnExit();
		} else if (storageSyncOn()) pushStorageNow();
	});
	document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") scheduleStoragePush(); });
	setInterval(() => { if (document.visibilityState === "visible") scheduleStoragePush(); }, 5 * 60 * 1000);
	let rjWipeVisibleAt = 0;
	document.addEventListener("visibilitychange", () => {
		if (document.visibilityState !== "visible") return;
		const now = Date.now();
		if (now - rjWipeVisibleAt < 30000) return;
		rjWipeVisibleAt = now;
		checkWipeTombstone();
	});
	try {
		new BroadcastChannel("rj-wipe").addEventListener("message", (ev) => {
			const at = ev && ev.data && ev.data.at ? Number(ev.data.at) : Date.now();
			if (at > rjWipeAck) {
				rjWipeAck = at;
				localStorage.setItem("rj-wipe-ack", String(at));
				doLocalWipe();
			}
		});
	} catch (err) {}
}

// -- account / admin api wrappers ------------------------------------------------
async function syncToggle() {
	try {
		const r = await fetch("/auth/sync-toggle", { method: "POST" });
		const d = await r.json();
		if (d && d.ok) {
			setMe({ ...meInfo, syncEnabled: !!d.syncEnabled });
			if (d.syncEnabled) await hydrateFromServer();
		}
	} catch (err) {}
	return meInfo && meInfo.syncEnabled;
}
async function unlockSync(pw) {
	const rc = RC();
	if (!rc) return false;
	const ok = await rc.unlockWithPassword(pw);
	if (ok) await hydrateFromServer();
	return ok;
}
async function changePassword(oldPw, newPw) {
	const rc = RC();
	if (!rc) return { ok: false, error: "crypto missing" };
	return await rc.changePassword(oldPw, newPw);
}
async function signOut() {
	const rc = RC();
	if (rc) await rc.lock();
	location.href = "/auth/logout";
}
async function adminLoad() {
	try {
		const res = await fetch("/auth/admin/users");
		if (!res.ok) return null;
		return await res.json();
	} catch (err) { return null; }
}
async function adminAction(action, username) {
	await fetch("/auth/admin/" + action, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: "username=" + encodeURIComponent(username),
	});
}
async function adminConfig(key, on) {
	await fetch("/auth/admin/config", {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: key + "=" + (on ? "1" : "0"),
	});
}

// bridge hook registrations: the ported engine core calls these.
bridge.on("scheduleSyncPush", scheduleSyncPush);
bridge.on("scheduleStoragePush", scheduleStoragePush);
bridge.on("storageSyncOn", storageSyncOn);
bridge.on("markSync", markSync);

function bootSync() {
	wireWipe();
	return hydrateFromServer().then(enforceClearOnExitBoot).then(checkWipeTombstone);
}

export {
	markSync, scheduleSyncPush, scheduleStoragePush, storageSyncOn,
	getSiteStorageData, clearSiteStorageHost, clearAllSiteStorage,
	setCookieValue, deleteCookie, setSiteKey, delSiteKey,
	hydrateFromServer, syncToggle, unlockSync, changePassword, signOut,
	adminLoad, adminAction, adminConfig, bootSync,
};
