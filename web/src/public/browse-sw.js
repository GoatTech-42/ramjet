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
    return r;
  })());
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
