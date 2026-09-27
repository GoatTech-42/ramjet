# Ramjet addons

Addons are self-contained apps that live inside ramjet. Each one is its own
directory (usually its own repo) with a static frontend and an optional API
handler. Ramjet mounts them on the same origin, behind the same session gate,
so to the browser an addon is just part of ramjet.

Jetstream (`/jetstream/`) is the reference addon. When something below is
unclear, go read it - it's small and does everything on this page.

## Registering an addon

Addons are listed in `ramjet-data/addons.json`:

```json
[
  {
    "id": "jetstream",
    "name": "Jetstream",
    "entry": "/jetstream/",
    "dir": "/home/luke/goattech/jetstream",
    "hasApi": true
  }
]
```

| field   | meaning                                                        |
| ------- | -------------------------------------------------------------- |
| `id`    | lowercase letters, numbers, dashes. Becomes the URL prefix.    |
| `name`  | shown on the home-page tile.                                   |
| `entry` | where the tile links. Almost always `/<id>/`.                  |
| `dir`   | absolute path to the addon directory on the server.            |
| `hasApi`| set true if the addon ships a `server.js` (see below).         |

Some ids are reserved (`api`, `auth`, `search`, `login`, `assets`, `sw.js`,
`rjcrypto.js`, a few more) because they'd shadow ramjet's own routes - entries
with those ids are skipped at load time, as is anything that fails validation.

Restart ramjet after editing `addons.json`.

## Directory layout

```
myaddon/
  public/        # everything here is served at /<id>/
    index.html
    app.js
    style.css
  server.js      # optional, required when hasApi is true
```

`/<id>/...` serves files out of `public/`. A bare `/<id>/` serves
`public/index.html`. Paths are cleaned and can't escape the directory. HTML
is served no-cache, everything else gets an hour of cache - so version your
asset URLs (`app.js?v=3`) when you ship an update.

## The API handler

With `hasApi: true`, requests to `/api/<id>/<route...>` dispatch to the
default export of `<dir>/server.js`:

```js
export default async function handle(req, res, route, url, ctx) {
  if (!ctx.user) { res.writeHead(401); return res.end("no session"); }
  if (route === "hello" && req.method === "GET") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ ok: true }));
  }
  res.writeHead(404); res.end();
}
```

- `req`, `res` - the raw node request/response. No framework, you own the wire.
- `route` - the path after `/api/<id>/`, e.g. `/api/myaddon/hello` -> `"hello"`.
- `url` - the parsed `URL` (query params live here).
- `ctx.user` - the logged-in ramjet username, or `null`. Check it yourself;
  the dispatch happens inside the session gate but a null check is one line.

The handler is imported lazily on first request and cached for the life of the
process - deploys need a ramjet restart to pick up server.js changes.

## Sessions

Everything under `/api/<id>` and `/<id>/` sits behind ramjet's normal auth
gate, same as ramjet itself. If someone reaches your handler at all, they
came through the gate; `ctx.user` tells you who. There is no addon-visible
login flow and there shouldn't be - don't build one.

## Per-user storage (synced, encrypted)

Addons don't get their own server-side database. Per-user data rides ramjet's
encrypted sync blob instead:

- The blob is encrypted client-side (AES-GCM via `rjcrypto.js`, included on
  your page with `<script src="/rjcrypto.js"></script>`). The server stores
  ciphertext and can't read it. Keep it that way - never design an addon that
  asks the server to store user content in plaintext.
- The blob is a single JSON object shared by ramjet and every addon. Ramjet
  uses `history`, `bookmarks`, `settings`. Your addon takes **one namespaced
  key** - jetstream uses `blob.jetstream` - and keeps everything under it.
- Always read-modify-write and never drop keys you don't own:

```js
const blob = (await RJCrypto.pull()) || {};
blob.myaddon = { /* your stuff */ };
await RJCrypto.push(blob);   // preserves history/bookmarks/settings/others
```

- Sync can be locked or off. Fall back to `localStorage` and treat the blob
  as the upgrade, not the only copy. Jetstream's `loadLocal`/`loadRemote`/`save`
  trio is the pattern to copy.

## Theme

Follow the user's ramjet theme instead of hardcoding your own. Ramjet persists
appearance settings same-origin under the `rj.settings` localStorage key
(`{ theme, customAccent, ... }`), and its sync writes the same key on every
device - so reading it gets you the synced theme for free:

```js
const s = JSON.parse(localStorage.getItem("rj.settings") || "null");
// s.theme: amber | mint | sky | violet | ember | custom
// s.customAccent: "#rrggbb" when theme is custom
```

Apply it to your CSS variables on load. Honor `s.lowData` too: when it's on,
skip prefetching and other nice-to-have traffic.

## House rules

- Stay framework-free and small. The box is little; the client is a phone.
- Cache upstream work server-side where you can (jetstream caches API
  responses in-process with a TTL; failures are never cached).
- Gzip JSON responses over ~1KB when the client accepts it.
- The client must never need to talk to a third-party origin. Proxy anything
  external through your `/api/<id>` routes. That's the whole point.

MIT, same as ramjet.
