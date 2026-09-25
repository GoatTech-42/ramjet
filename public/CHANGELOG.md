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
