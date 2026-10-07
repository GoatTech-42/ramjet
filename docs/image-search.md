# Image source policy

Public returned results are cached across web/Lite users and process restarts. Keys include normalized query, category, safe-search, native upstream page and CSE eligibility. Successful CSE or backup image pages live 30 minutes; failed/fallback pages live one minute. The cache has 100 entries/8 MiB maximum and mode600 because queries can be private. One explicit page means one upstream page, never eager filling or prefetch.

Source order: Qwant first; if unavailable/empty, Google CSE; then Google Images via SerpApi; then Brave. Actual lazy selection means a successful Qwant page triggers no later sources. Qwant uses the built-in SearX adapter with safesearch0/1/2, its own persisted24/10min admission/gap and10min circuit breaker. It shares the budget file but not the Google-specific cooldown. Qwant failures are cached and skipped during its cooldown. Brave images has the same separate persisted24/10min,3s-gap,10min failure circuit. These are risk limits, not guarantees that a scraper avoids bot checks. The backup is disabled without `SERPAPI_API_KEY` in the running process environment. Provision it outside source control. Never put a real key in git, a URL shared with a person, logs or client code. Use a dedicated free account/key with automatic paid renewal off. No signup or account change is performed by this code.

SerpApi documents `safe=active|off`. Both app moderate and strict map to active (filtered). Neither uses the unspecified blur default. Off explicitly sends off. Brave's adapter maps all three modes, including real off. No source lacking off is added here.

All SerpApi attempts are reserved before I/O in the existing persisted cse-budget.json. Limit: 200 attempts in any rolling31days and40/hour, including failed requests and provider-cache hits. No automatic calendar reset, paid renewal, retries or cap bypass. This is intentionally below the current free250/month and50/hour. It cannot cover requests made by other clients sharing the key; do not share the key with another service. Failures add10minute SerpApi and shared CSE cooldown. Existing CSE pacing and24/10minute cap remain.

Documentation checked October6,2026:
- https://serpapi.com/google-images-api (safe values, zero-based ijn, response fields)
- https://docs.searxng.org/_modules/searx/engines/qwant.html (undocumented API, safesearch mapping, CAPTCHA risk)
- https://serpapi.com/pricing (free250/month,50/hour)

Run `node --test tests/*.test.mjs`. Deployment still needs Docker, restored populated-data smoke, private-cache permissions and restart checks. Verify source order with fixtures, not repeated live paid or Google queries. Optional adapter is not an assertion that a key/account is connected or a live source is working.
