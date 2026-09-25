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
