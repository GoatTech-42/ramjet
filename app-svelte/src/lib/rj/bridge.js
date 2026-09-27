// bridge: legacy core -> Svelte shell seams. The Svelte components register
// their render/refresh callbacks here; the ported core calls these hooks.
const hooks = {};
export function on(name, fn) { hooks[name] = fn; }
export function call(name, ...args) { if (hooks[name]) return hooks[name](...args); }

export function renderTabs() { call("renderTabs"); }
export function syncBar() { call("syncBar"); }
export function renderDlBadge() { call("renderDlBadge"); }
export function renderDownloads() { call("renderDownloads"); }
export function openSwitcher() { call("openSwitcher"); }
export function closeSwitcher() { call("closeSwitcher"); }
export function openMenu(...a) { call("openMenu", ...a); }
export function hideMenu() { call("hideMenu"); }
export function openFind() { call("openFind"); }
export function hideFind() { call("hideFind"); }
export function renderSuggest(...a) { call("renderSuggest", ...a); }
export function hideSuggest() { call("hideSuggest"); }
export function renderHistory(...a) { call("renderHistory", ...a); }
export function renderHistoryPage() { call("renderHistoryPage"); }
export function openSettings() { call("openSettings"); }
export function applyZoom() { call("applyZoom"); }
export function markSync(...a) { call("markSync", ...a); }
export function scheduleSyncPush() { call("scheduleSyncPush"); }
export function scheduleStoragePush() { call("scheduleStoragePush"); }
export function storageSyncOn() { return call("storageSyncOn"); }
export function collectSiteStorage(...a) { return call("collectSiteStorage", ...a); }
export function installLowData(...a) { return call("installLowData", ...a); }
export function recordHistory(...a) { return call("recordHistory", ...a); }

// element registry: Svelte shell registers the live DOM nodes the core needs.
export const els = {};
export function registerEl(name, el) { els[name] = el; }
// null-object element: absorbs property reads/writes and method calls for
// legacy lookups of UI nodes the new shell has replaced.
export const nullEl = new Proxy(function () {}, {
	get: (t, p) => {
		if (p === "classList") return { add() {}, remove() {}, toggle() {}, contains: () => false };
		if (p === "dataset") return {};
		if (p === "style") return {};
		return nullEl;
	},
	set: () => true,
	apply: () => nullEl,
});
