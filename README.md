# ramjet (rebuild)

Self-hosted web hub: one login, a themed home, and the apps behind it.

- **browse** - proxied web browser with tabs, bookmarks, history, reader, per-site ad blocking, downloads
- **ramjet search** - own results page (web, images, videos, news, maps) over a self-hosted SearXNG
- **jetstream** - video feed with a warm disk cache
- **amp** - music search and queue across catalogs
- **sage** - chat assistant (free hosted models, no keys)
- **banter** - chat with friends
- **settings** - themes (ramjet, glass, terminal, paper), layouts, data saver, privacy (saving searches is off by default)

Press Ctrl/Cmd-K for the command palette.

## Run

    npm install
    npm run build        # web/ -> dist
    node core/index.js   # RJ_PORT (default 14224), RJ_HOST (default 127.0.0.1), RJ_DATA

Per-account state lives in data/ (not in git). Static proxy files under /cloak, /scramjet, /controller, /epoxy and /libcurl are served no-cache.

## Notes

- Thumbnails: settings > data saver (auto / on / off). On or auto-on-cellular sends smaller thumbnails and video.
- Docs: docs/features.md, docs/cutover-runbook.md, docs/domain-transfer-prep.md. Build log: PROGRESS.md.
- Branch rebuild-v2 is the live rebuild; main still holds the older v1.
