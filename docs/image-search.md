# Search

Home/Browse text queries open DuckDuckGo itself through the existing proxy: `https://duckduckgo.com/?q=QUERY`. DuckDuckGo owns its results and Images tab. Ramjet no longer renders or scrapes custom web results. Old authenticated `/searx/` query links redirect into Browse; they do not fetch search data.

The authenticated phone Shortcut endpoints `/api/lite/imgsearch` and `/api/lite/imgsheet` remain. They fetch Qwant v3 image data directly, one requested native page at a time, no fallback. Safe-search maps off/moderate/strict to0/1/2. Qwant is undocumented and can block or CAPTCHA; errors say unavailable instead of pretending empty success or trying hidden engines.

Qwant pages are shared across accounts/restarts in private mode600 `qwant-images-cache.json`,30min for results,60sec for failure/empty. Key includes query/native page/safe level;100 entries/8MiB. Concurrent requests coalesce before admission. Persistent `qwant-budget.json` limits24 admissions/10min with3sec gap and10min failure cooldown. These limits reduce scraping risk, not guarantee reliability. No Google/Brave/SerpApi adapter or key wiring remains.

SearXNG child startup and Docker build/setup removed. Before rollout box privately backs up its settings; after Docker and live navigation/Shortcut verification it may reclaim old files. Existing provider/budget/cache files are not silently deleted or copied. This patch does not stop or clean the production service itself.

Sources verified:
- https://duckduckgo.com/?q=goat (real query page format)
- https://docs.searxng.org/_modules/searx/engines/qwant.html (Qwant request/response shape,50 images/page,0/1/2 mapping)

Run `node --test --test-concurrency=1 tests/*.test.mjs`. Live tests should be restrained, authenticated and source-specific. No automated retries on challenges.

Pinned Scramjet History bug: omitted/null third arguments previously coerced to `undefined`/`null` URLs. Build applies a count-checked local patch matching native History behavior. Local fixture verifies omitted/null URL does not change address; explicit relative URL still does. DDG live iPhone produced results; desktop test traffic received a CAPTCHA and was stopped. This is not proof of reliability on users' traffic. Queries still leave through server proxy, so IP-related challenges may affect actual browsing too.
