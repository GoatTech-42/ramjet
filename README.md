
## Proxy MIME behavior

For script destinations the proxy preserves the origin's
`X-Content-Type-Options: nosniff` header, so the browser refuses non-JS
script types exactly as it would on a direct connection. A classic script
without nosniff has no MIME gate (browser behavior, proxied or not), so a
wrong-typed response without nosniff still executes; module scripts keep
their own stricter JS-type requirement.

## Deploys and tests

Deploys must restart the server process. The engine build stamp
(`?v=<ENGINE_STAMP>` on the engine/boot urls), the stamped asset bytes and the
pages are all snapshotted into memory at boot; a rebuild without a restart
keeps serving the boot bytes under the boot stamp. Restart on every deploy.

Tests need dependencies and a build first:

    npm ci
    npm run build
    node --test tests/*.test.mjs

Browser tests additionally need playwright and a chrome binary:

    RJ_PLAYWRIGHT=/path/to/playwright/index.mjs RJ_CHROME=/path/to/chrome node tests/browser/proxied-ws.mjs
    RJ_PLAYWRIGHT=/path/to/playwright/index.mjs RJ_CHROME=/path/to/chrome node tests/browser/local-fixture-smoke.mjs
