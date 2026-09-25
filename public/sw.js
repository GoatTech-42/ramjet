// Ramjet service worker - Scramjet v2 engine integration
// (@mercuryworkshop/scramjet-controller, MIT).
importScripts("/controller/controller.sw.js");

// -- download interception ----------------------------------------------------
// attachment responses (and unrenderable octet-stream documents) are rerouted
// to the app's download manager instead of the browser's native save flow.
function rjIsDownload(res, dest, mode) {
	// navigations only - background XHR/fetch/script responses often carry
	// defensive Content-Disposition: attachment headers (google f.txt etc.)
	if (mode !== "navigate" && dest !== "document" && dest !== "iframe") return false;
	const cd = res.headers.get("content-disposition") || "";
	if (/^\s*attachment/i.test(cd)) return true;
	const ct = (res.headers.get("content-type") || "").toLowerCase();
	if (ct.indexOf("application/octet-stream") === 0 && (dest === "iframe" || dest === "document")) return true;
	return false;
}
function rjFilename(res, url) {
	const cd = res.headers.get("content-disposition") || "";
	let m = /filename\*=(?:UTF-8'')?([^;]+)/i.exec(cd);
	if (m) { try { return decodeURIComponent(m[1].trim().replace(/^"|"$/g, "")); } catch (err) {} }
	m = /filename="?([^";]+)"?/i.exec(cd);
	if (m) return m[1].trim();
	try {
		const tail = new URL(url).pathname.split("/").pop();
		if (tail) return tail;
	} catch (err) {}
	return "download";
}
async function rjHandoff(e, res) {
	const url = e.request.url;
	const msg = {
		type: "rj:download",
		url: url,
		name: rjFilename(res, url),
		size: Number(res.headers.get("content-length")) || 0,
		mime: res.headers.get("content-type") || "",
	};
	if (res.body) res.body.cancel().catch(() => {});
	const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
	for (const w of wins) w.postMessage(msg);
	return new Response(
		'<!doctype html><meta charset="utf-8"><title>download</title><body style="background:#0d0f12;color:#8b939e;font:14px system-ui;display:grid;place-items:center;height:100vh;margin:0">download started - see the downloads page</body>',
		{ status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
}

addEventListener("fetch", (e) => {
	// our own native search page + image proxy must never enter the proxy
	// engine: the wisp transport would loop back to this origin and fail.
	const rp = new URL(e.request.url);
	if (rp.origin === location.origin && (rp.pathname === "/search" || rp.pathname === "/th")) return;
	if (!$scramjetController.shouldRoute(e)) return;
	if (e.request.headers.get("x-rj-dlm")) {
		// managed download fetch: strip the marker, route without intercepting
		const h = new Headers(e.request.headers);
		h.delete("x-rj-dlm");
		const req = new Request(e.request, { headers: h });
		e.respondWith($scramjetController.route({ request: req, clientId: e.clientId, resultingClientId: e.resultingClientId }));
		return;
	}
	e.respondWith((async () => {
		const res = await $scramjetController.route(e);
		if (e.request.method === "GET" && rjIsDownload(res, e.request.destination, e.request.mode)) return rjHandoff(e, res);
		return res;
	})());
});
