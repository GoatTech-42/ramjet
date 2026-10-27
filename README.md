# ramjet

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

Node 20+ (the Dockerfile pins node:20-bookworm-slim).

    npm install
    npm run build        # syncs proxy vendor files into web/, then vite builds web/ -> web/dist
    node core/index.js   # or: npm start

Environment: RJ_PORT (default 14224), RJ_HOST (default 127.0.0.1), RJ_DATA (default ./data).

Per-account state lives in data/ (not in git). Static proxy files under /cloak, /scramjet, /controller, /epoxy and /libcurl are served no-cache with ETag revalidation.

A Dockerfile and docker-compose.yml are included for container runs; the image build expects a local models/ directory (gitignored).

## Repository layout

- **core/** - Node server: auth, proxy/browse, SearXNG search, amp, jetstream, sage
- **web/** - Svelte front end, built to web/dist by `npm run build`
- **scripts/, bin/, searxng/, qa/** - build helper, bundled yt-dlp, local SearXNG setup, internal QA scripts
- **current-source/** - preservation snapshot of the current accepted Rust backend source (AGPL + MIT-origin notices; build notes in current-source/README.md). Published for preservation/license compliance; it is not built or run by the commands above.
- **frontend/** - AGPL corresponding-source publication of the deployed frontend (hub shell + r32 app pages). Notes in frontend/PUBLICATION.md, build recipe in frontend/RECIPE.md.

## Notes

- Thumbnails: settings > data saver (auto / on / off). On or auto-on-cellular sends smaller thumbnails and video.
- main is the current branch. rebuild-v2 is an older line and is now behind main.
