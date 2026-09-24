# Ramjet

A fast web proxy by GoatTech. One bar, the whole web - no accounts, no install.

Ramjet runs on the [Scramjet](https://github.com/MercuryWorkshop/scramjet) engine
(interception + rewriting in a service worker) with a [wisp](https://github.com/MercuryWorkshop/wisp-js)
transport over a single websocket per tab.

## Self-host

Requires Node.js 20+.

```sh
npm install
npm start          # listens on 0.0.0.0:4204
```

Set `RAMJET_PORT` / `RAMJET_HOST` to change the bind.

Public deployments need HTTPS (service workers require a secure context);
put it behind any TLS reverse proxy and it works as-is.

## Layout

- `server/index.js` - static hosting + wisp websocket on one port
- `public/` - the UI (custom, hand-written)
- engine + transports are served straight from `node_modules` at `/scram/`, `/baremux/`, `/libcurl/`

## License

MIT. Engine by Mercury Workshop (MIT); service-worker glue follows the standard Scramjet deployment pattern.
