# ramjet changelog

## v1.0.3 - 2026-09-26
- fix: clear-history-on-close actually works now (Luke report) - moved to pagehide (iOS never fired beforeunload) and the wipe clears the synced copy too, so hydrate no longer resurrects cleared history; boot re-enforces the wipe if a close was interrupted
- new setting: clear cookies when ramjet closes (empties the engine cookie jar locally + in sync)


## v1.0.2 - 2026-09-25
- browsing mode default is same-tab embedded on ALL devices (Luke: popup only if it has to); popup modes fire only via the failure fallback chain or an explicit settings choice

## v1.0.1 - 2026-09-25
- per-device default browsing mode: phones default to same-tab embedded flow (no full-screen popup browser), desktops keep full-page+bar; explicit settings choice always wins; failures fall back through the existing chain (Luke steer)

## v1.0 - 2026-09-25
v1 release. Everything since v0.11, shipped as one consistent set:
- per-account cookie sync toggle (sync cookies with settings, per account)
- fix double-popup on boot: restored full-mode tabs stay dormant until focused
- all DOM ids obfuscated (95 ids, scripts/idmap.json for tooling)
- popup bar restyled to match the shell (Luke's pick)
- speed pass: gzip statics (2.1MB -> 620KB boot payload), etag+304, 1h cache on versioned assets - closes the last v1 gate (speed 8 -> 9)
- /login?reset=1: one-tap recovery from stale-service-worker white pages
- mobile fixes: search results no longer overflow narrow viewports (min-width bug), accent applies before first paint (no amber flash on page switches; login keeps default orange)
- low data mode (v0.12, mobile-only, off by default): lazy images, no autoplay, no media preload, no prefetch/preload hints on proxied pages

## v0.11 - 2026-09-25
obfuscation pass: engine fingerprint surface removed end-to-end.
- vendored engine libs under /lib/ with bland names (boot/core/api/inject/engine.sw); /scramjet/ + /controller/ mounts and /CHANGELOG.md no longer served (404)
- globals renamed: $scramjetController/$scramjet -> $wkcore/$wkcfg, __rjController/__rjPopUrl -> __goc/__gop, indexedDB + BroadcastChannel names renamed, SCRAMJET*/Scramjet* identifiers renamed, sourcemap comments stripped, wasm binary strings renamed
- proxied URL shape changed: /~/sj/ -> /view/<tag>/<codec>/<url>
- retired about:blank popout button + handler (documented filter signature); full-page popout stays
- health endpoint no longer names the engine

## v0.10.6 - 2026-09-25
- new: full-page mode (settings or "pop out full page") opens proxied pages TOP-LEVEL in their own browser tabs - no iframe anywhere, so school/office filters that block framed proxy content (X-Frame-Options injection, embed filtering) never see an embed. The ramjet tab stays open as the engine's transport owner.
- verified on staging through a simulated web filter (port-forwarded host blackholed): omnibox and search-result navigations pop out full-page and render top-level through the tunnel; 100% of requests ride the serving origin.

## v0.10.4
- fix: on a slow connection the first engine boot could hit its 12s timeout, reload, then fail anyway even though the engine came up seconds later - restored tabs sat blank until clicked. the timeout reload now only fires against a genuinely stale worker; slow first boots and post-reload boots are waited out instead of failed

## v0.10.3
- fix: the origin rewrite now only trusts addresses ramjet is actually served on - without that, real sites that live at /search (google.com/search!) would have been hijacked into ramjet search when opened from history or bookmarks

## v0.10.2
- fix: tabs, history, bookmarks and downloads saved on one ramjet address carried that address onto the other - on the tunnel url, restored searches and pages tried to load through the port-forwarded host, which is blocked on some networks. anything aimed at ramjet's own paths is now rewritten to the address ramjet is actually served on

## v0.10.1
- fix: the search box now opens urls through the proxy instead of searching for the string - "wikipedia.org" goes to the site, "wikipedia" still searches
- fix: a stale service worker could hang the engine boot forever (every proxied page stuck) - boot now times out, drops the dead worker and reloads once; new workers take over immediately and the worker script is pinned to the shipped version

## v0.10.0
- image lightbox: blurred backdrop, loading spinner with fade-in, position counter (n / total)
- hovering an image tile preloads the full-size image so the lightbox opens instantly

## v0.9.9
- deep link: /?u=<url or search> opens through the proxy like an omnibox submit (enables iOS Shortcut + share-sheet entry points)

## v0.9.8
- fix: searching from the ramjet bar failed with "this page didn't load" - the app only bypassed the proxy engine for /searx/ paths, so /search went through the wisp transport, which looped back to our own origin and died. /search and /th now bypass the proxy in the service worker and in the app's navigation, and result links from the native page route through the proxy like the skin's did

## v0.9.7
- lightbox prev/next buttons + arrow-key navigation through the image grid; image tiles get hover captions, resolution badge moves to the top corner

## v0.9.6
- perceived-speed prefetching: hovering a tab warms it in the server cache, page 2 prefetches at idle - tab switches and next page feel instant

## v0.9.5
- custom styled filter dropdowns (accent ring, animated popover), site favicons in result crumbs, results count + timing line, "/" focuses the search box

## v0.9.4
- native search results page at /search: server-rendered from the local searxng JSON api - 5 tabs, answer box, infobox, image grid with google-style lightbox preview, video durations, news dates, pagination, loading bar, animations, tooltips. image thumbnails proxy through the server (/th) so they load reliably and the phone never talks to third-party CDNs. /autocompleter route removed; default engine points at /search; the searxng skin stays as the home page

## v0.9.3
- downloads manager stops recording background junk: google/youtube xhr responses and tracker scripts carry defensive attachment headers and were getting captured as downloads. only real navigations count as downloads now. hit clear finished once to wipe the old entries

## v0.9.2
- tab bar decluttered: phones show just back, address, tabs and one dots menu - forward/reload/home/bookmark/downloads/cloak/settings/hide-bar/lock live in the menu now, like a real mobile browser. desktop keeps the useful row visible and tucks cloak/hide-bar/lock away
- suggested searches removed from the address bar per Luke - it never pops up
- ramjet search stays (reversed the removal) - complete style rebuild: image results grid fixed (broken since v0.9.0), horizontal overflow killed, preferences + about pages branded (dart logo, readable tabs), autocomplete dropdown actually works now (was clipped by the search box; also added a root /autocompleter proxy route so the theme JS reaches searxng), dropdown capped at 45vh with internal scroll
- searxng skin custom.css v116

## v0.9.1
- search is FAST now: repeat searches and back/forward come back instantly (built-in result cache), pages transfer ~85% smaller (gzip), slow dictionary/translation engines dropped from the default set, stragglers cut at 2.5s
- search follows your accent color - links, buttons, tabs, logo, everything picks up your ramjet theme (amber/mint/sky/violet/ember/custom) instead of always amber
- omnibox suggestions now come from ramjet search itself as you type, with past visits trimmed to 3 and dimmed so real suggestions lead
- results page decluttered: about link gone, settings shrinks to a quiet gear, filter row hidden on phones; wider results on big screens, sticky search bar, tighter type and hover states
- search history rows show as "ramjet search: your query" instead of a raw url

## v0.9.0
- ramjet search: your own private search engine, built in - metasearch powered by a searxng instance running on the same box, fully skinned in the ramjet dart theme. it's the default search engine now (old default moves over automatically; if you picked another engine yourself it stays). also reachable directly at /searx for signed-in users
- search runs in a locked-down container: 400MB memory cap, no outside network identity, zero idle cpu

## v0.8.5
- error pages: when a site can't be reached the tab now shows a proper ramjet error page - accent dart, what happened in plain words, the address that failed, try again + go back. three covers: instant answers for clear failures (engine hook), the browser's own dead page gets swapped for ours, and sites that never answer get a 15s timeout page. the address bar keeps showing the failed address
- fix: settings button icon was a sun - now a proper gear

## v0.8.4
- fix: "pop out to about:blank" did nothing - two bugs: clicking it from settings found no page to pop out (settings is its own tab now), and phones/home-screen apps block window.open entirely. it now pops out the last site you were on, and if the popup cant open it swaps the current tab instead, so it works everywhere

## v0.8.3
- fix: settings restored open on boot showed every page stacked - the saved page filter now reapplies on restore
- checkboxes are fully themed now: dark box with a proper amber check instead of the browser default white box
- panic url field has a placeholder so an empty field no longer looks like a broken box
- downloads + history pages get the themed scrollbar too

## v0.8.2
- settings redesign: sections are now real pages - nav rail on desktop (appearance / search / startup / cloak & panic / privacy / bookmarks / account / about), top tab strip on phones; wider card, one page visible at a time

## v0.8.1
- history page: full page (ctrl+h or settings > history > full page) with live search, per-site grouping, per-site clear, per-entry remove, clear by range (last hour / today / all time)
- history now remembers page titles and keeps 1000 entries (was 100)

## v0.8.0
- downloads manager: the engine now hands attachment downloads to ramjet instead of the browser - real downloads page (toolbar arrow, landing + in-flight), live progress, pause/resume (range resume when the site supports it), cancel, save to device, open-in-tab for finished files, retry for interrupted
- badge on the downloads button while anything is in flight

## v0.7.5
- fix: favicon did not follow the accent - the cloak pass ran after the theme pass and reset the icon to the static amber file every boot. cloak "off" now renders the themed dart; active cloaks unchanged

## v0.7.4
- fix: orange ghost on the wordmark j/t on iOS - WebKit left a stale paint pass on glyph overhang (descender / italic edge) during the accent-color transition; the wordmark accent no longer transitions, color applies atomically
- fix: desktop login "//" separator sat at the top of the bar - it was an unstretched flex item; now centers itself

# ramjet changelog

## 0.7.3
- theme: last hardcoded orange gone (go-button hover) - accent now covers everything
- iphone: no more auto zoom-in when you type (all inputs 16px minimum on phones)

## 0.7.2
- engine fix: live server was missing engine packages - the proxy actually boots now
- phones: text no longer auto-inflates (fixes sideways scrolling + broken settings layout)
- no more horizontal scrollbar on mobile - everything fits the screen
- dart logo + favicon follow your accent color

## 0.7.1
- removed the auto history-suggestion chip on the new-tab page (it had a style conflict on phones) - a proper pinned speed dial lands in v0.8

## 0.7.0
- new engine: scramjet 2 - more sites just work
- phone layout: real bottom bar, card-grid tabs, pill address field
- mobile login: form stacks properly on phones
- custom accent color: pick any color in settings
- settings sync: theme + options follow you across devices
- cache self-heal: updates reach you on next open, no more stale versions
- changelog in settings (you are here)
- cookie sync (admin): site logins follow you phone <-> desktop
- site data sync (admin): per-site localStorage rides along too
- site storage manager: per-site cookies + data, view/edit/delete, clear one or all
- login form plays nice with password autofill now
- custom search engine: set any engine with your own search url
- startup option: reopen last session's tabs (on by default)

## 0.6.0
- encrypted per-account sync (history, bookmarks, settings)
- tab cloak + panic key
- zoom control

## v0.11.1 - in progress
- cookie sync per account: settings > account toggle "sync cookies + site data for this account" (off by default), admin per-user sync on/off in the accounts list; the encrypted sync pipeline now follows each account's flag instead of admin-only
