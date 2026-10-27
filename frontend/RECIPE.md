# build recipe (as run for this candidate)

node/npm: node 22+, npm 10+. two source trees, one staged output.

## 1. r32 app pages (/source/r32)
    npm ci
    npx vite build
  emits r32/dist: pages/<page>/<page>.html for 10 pages + assets + engine statics (scramjet/, epoxy/, libcurl/, controller/, skin/, browse-sw.js, root statics from src/public).

## 2. c7 hub shell (/source/hub)
    npm ci
    RAMJET_SOURCE_SHA=<7-char git sha> RAMJET_COMMIT=<commit> RAMJET_IMAGE_TAG=<image tag> npm run build
    (production also sets RAMJET_SOURCE_URL=<read-backed published commit url> - the AGPL s13 corresponding-source offer shown in settings > advanced; empty hides the row)
  emits hub/dist: index.html, assets (index-*.js/css), pages/{index,settings}.
  this candidate used 0000000 / 0000000 / parity-check deliberately; production supplies real identity.

## 3. stitch (/source/hub/scripts/stitch-r32.mjs + build-stamp.mjs)
    cd hub && RAMJET_COMMIT=<commit> RAMJET_IMAGE_TAG=<tag> \
      node scripts/stitch-r32.mjs <r32-dist> <hub-dist> <staged-out> <manifest-out>
  - copies hub dist, then engine dirs from r32 dist with served-path renames
    (scramjet->assets/codec, epoxy->assets/net, libcurl->assets/net2, controller->assets/player with api/worker/inject renames, skin->skin)
  - single input per engine static: staged/assets/net2/index.mjs is the same file as source/r32/src/public/libcurl/index.mjs, carried through r32/dist/libcurl/index.mjs by the vite build and renamed by stitch. there is no second, separately served copy of net2 (or any engine static).
  - browse-sw.js -> a/player-boot.js
  - applies the counted cross-reference rewrites inside engine files (hard-fails on count mismatch)
  - strips engine sourcemap refs
  - copies r32 assets reachable from KEPT pages (login password claim banter sage amp browse jetstream) via referenced-asset closure; replaced r32 shell pages ship nothing
  - stamps every page with the build identity and verifies; writes sha256 manifest
