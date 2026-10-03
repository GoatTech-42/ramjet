importScripts("/controller/controller.sw.js");

// update in place: a new build activates immediately instead of queueing
// behind whatever version the browser ran last visit.
addEventListener("install", () => { try { skipWaiting(); } catch {} });
addEventListener("activate", (e) => { e.waitUntil(clients.claim()); });

// scramjet resolves its own failures as a status-500 text page full of
// rust debug output. swap those for a page that reads like ramjet made
// it - only for real page loads, and only when the body is the marker.
addEventListener("fetch", (e) => {
  if (!$scramjetController.shouldRoute(e)) return;
  e.respondWith((async () => {
    let r;
    try {
      r = await $scramjetController.route(e);
    } catch (err) {
      return errPage();
    }
    // marker check carries the precision - a real site never says this
    if (r.status >= 500) {
      try {
        const text = await r.clone().text();
        if (text.startsWith("Internal Service Worker Error")) return errPage();
      } catch { /* fall through to the original response */ }
    }
    const dl = dlInfo(e, r);
    if (dl) { try { return trackDownload(r, dl); } catch { return r; } }
    return r;
  })());
});

// downloads: a navigation answered with an attachment (or a file the page
// can't show) still goes to the browser's own download manager, but the
// body passes through a counter so the Browse page can show progress and
// cancel it. nothing is buffered.
const rjdlCancels = new Map();
const hint = { url: "", ts: 0 };
const SHOWABLE = /^(text\/|image\/|video\/|audio\/|application\/(json|xml|xhtml\+xml|pdf|javascript|x-javascript|ld\+json|rss\+xml|atom\+xml)|multipart\/)/i;
function dlInfo(e, r) {
  if (r.status !== 200 || !r.body) return null;
  const nav = e.request.mode === "navigate" || e.request.destination === "document" || e.request.destination === "iframe";
  if (!nav) return null;
  const cd = r.headers.get("content-disposition") || "";
  const ct = r.headers.get("content-type") || "";
  const att = /^\s*attachment/i.test(cd);
  if (!att && (!ct || SHOWABLE.test(ct))) return null;
  let name = "";
  const m = cd.match(/filename\*\s*=\s*[^']*'[^']*'([^;]+)/i) || cd.match(/filename\s*=\s*"?([^";]+)"?/i);
  if (m) { try { name = decodeURIComponent(m[1].trim()); } catch { name = m[1].trim(); } }
  if (!name) { const seg = hint.url && Date.now() - hint.ts < 20000 ? (() => { try { return decodeURIComponent(new URL(hint.url).pathname.split("/").pop() || ""); } catch { return ""; } })() : ""; name = seg || ""; }
  if (!name) { const ext = ({"application/zip": ".zip", "application/pdf": ".pdf", "application/x-7z-compressed": ".7z", "application/vnd.android.package-archive": ".apk", "application/x-msdownload": ".exe", "application/gzip": ".gz", "application/x-tar": ".tar", "application/json": ".json"})[ct.split(";")[0].trim().toLowerCase()] || ""; name = "download" + ext; }
  name = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").slice(0, 120) || "download";
  return { name, att, size: Number(r.headers.get("content-length")) || 0 };
}
async function rjdlSay(msg) {
  try { for (const c of await clients.matchAll({ type: "window", includeUncontrolled: true })) c.postMessage({ rjdl: msg }); } catch {}
}
function trackDownload(r, dl) {
  const id = Math.random().toString(36).slice(2, 10);
  const reader = r.body.getReader();
  let got = 0, last = 0, ctrl, dead = false;
  const stream = new ReadableStream({
    start(c) { ctrl = c; },
    async pull(c) {
      try {
        const { done, value } = await reader.read();
        if (done) { rjdlCancels.delete(id); if (!dead) rjdlSay({ id, state: "done", got }); try { c.close(); } catch {} return; }
        got += value.byteLength; c.enqueue(value);
        const now = Date.now();
        if (now - last > 250) { last = now; rjdlSay({ id, state: "active", got }); }
      } catch (err) { rjdlCancels.delete(id); if (!dead) rjdlSay({ id, state: "error", got }); try { c.error(err); } catch {} }
    },
    cancel() { dead = true; rjdlCancels.delete(id); try { reader.cancel(); } catch {} rjdlSay({ id, state: "cancelled", got }); },
  });
  rjdlCancels.set(id, () => { dead = true; try { reader.cancel(); } catch {} try { ctrl.error(new TypeError("cancelled")); } catch {} rjdlCancels.delete(id); rjdlSay({ id, state: "cancelled", got }); });
  rjdlSay({ id, state: "active", got: 0, name: dl.name, size: dl.size, ts: Date.now() });
  const h = new Headers(r.headers);
  if (!dl.att) h.set("content-disposition", 'attachment; filename="' + dl.name.replace(/"/g, "") + '"');
  return new Response(stream, { status: r.status, statusText: r.statusText, headers: h });
}
addEventListener("message", (e) => {
  if (e.data && typeof e.data.rjdlHint === "string") { hint.url = e.data.rjdlHint; hint.ts = Date.now(); }
  const id = e.data && e.data.rjdlCancel;
  if (id && rjdlCancels.has(id)) rjdlCancels.get(id)();
});

function errPage() {
  return new Response(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>ramjet</title>
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
         background: #000; color: #ececec;
         font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
  .box { max-width: 340px; padding: 24px; text-align: center; }
  .brand { font-size: 28px; font-weight: 800; letter-spacing: -0.03em; margin: 0 0 18px; }
  .brand span { color: #d9f24b; }
  .msg { font-size: 17px; font-weight: 700; margin: 0 0 8px; }
  .hint { font-size: 14px; color: #b4b4b4; margin: 0; line-height: 1.5; }
</style>
</head>
<body>
  <div class="box">
    <p class="brand">ramjet<span>.</span></p>
    <p class="msg">that site didn't answer</p>
    <p class="hint">check the address for typos, or try again in a bit - some sites block proxied visits.</p>
  </div>
</body>
</html>`, { status: 502, headers: { "content-type": "text/html" } });
}
