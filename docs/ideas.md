
## Wed Sep 30 - thinking hour (2 AM)

Grounded in: his live data (jetstream 200 history/39 likes/18 dislikes/1 sub; sage 0 convos; amp 0 playlists; browse 0 bookmarks), PLAN.md (personal platform, parity first then better, human-made bar), and what the real platforms ship.

1. **jetstream: new-from-sub pill** (YouTube bell parity). He subs to exactly one channel and watches it through. When he opens jetstream and that channel has uploads he has not seen, a pill up top: "3 new from <channel>". On a personal platform with a tiny sub list this is the single highest-love feature YouTube has, and it costs one channel-rss check on open.

2. **browse: history + recently closed** (every real browser has it; his has none). His bookmark file is empty - bookmarking is work, history is free. Passive per-account log of proxied pages (title+url+when), searchable from the omnibox, plus a recently-closed list. This is the safety net that makes the proxy browser feel like a real daily browser instead of a demo.

3. **amp: radio from any track** (Spotify autoplay parity). amp is unused because the entry cost is "build a playlist from nothing". One button on any track - radio - queues similar songs forever off the same InnerTube watch-next graph jetstream already uses. Entry cost drops to one tap, which is the difference between an app he has and an app he uses.

4. **sage: starter prompts on the empty state** (ChatGPT parity). Zero conversations means the empty screen IS the product right now. ChatGPT ships suggested prompts because the first message is the hardest. Four honest one-tap starters tuned to him (not generic) so the first convo costs nothing.

5. **amp: daily mix seeded from jetstream taste** (beyond parity - the family play). Spotify made Daily Mixes the reason people open the app; nobody else can seed music taste from video watch-outcomes because nobody else owns both. The embed worker and outcome centroid already exist - this reuses them to drop one fresh playlist into amp each morning. It is the biggest idea on this list and the one that makes ramjet a family instead of four apps. Bigger build - do 1-4 first.

All five wait for Luke to pick. Nothing here is built.

## Thu Oct 1 - thinking hour (2 AM)

Grounded in: tonight's speed work (tunnel caps at ~1.1-1.6 MB/s, news pages are ~12 MB), the new search tabs, his "private unfiltered browsing" point, and what Arc, Brave, Kagi and YouTube ship. The five ideas from Wed still stand.

1. **browse: reader / lite mode** (Safari Reader, Brave Speedreader parity). The real cost on a news page is bytes, not handshakes. A one-tap lite view strips the page to text plus the main image, so a 12 MB page becomes about 200 KB through the same tunnel. Biggest speed win that does not depend on moving off the tunnel.

2. **search: bangs** (Kagi/DDG bangs). "!w cats" or "!yt cats" goes straight there, with a bangs list in settings. One-line parse in the search route. Makes search the front door of the proxy.

3. **browse: image recompression for heavy pages**. Resize and re-encode images to webp in the ws path, with a settings toggle. Images are most of the bytes. Needs an A/B through the tunnel before we trust it.

4. **search: "open in jetstream" on video results** (family play). Search, watch and queue stay inside ramjet. Nobody else owns both ends.

5. **browse: per-site memory of lite mode and ad blocking** (Arc per-site settings). Device-local and clearable. Only after 1.

Order I would pick: 1, 2, 3, 4. All wait for Luke. Nothing here is built.

## Fri Oct 2 - thinking hour (2 AM)

Grounded in: what shipped this week (playlists, restricted pre-check, overlay, Banter unread/reply/delete) and what Discord, iMessage, YouTube and Arc ship that we do not. Scope is frozen, so these are post-reveal candidates only.

1. **jetstream: audio-only mode** (YouTube Premium background play parity). Luke watches on a phone behind a filtered network; audio-only cuts bytes by roughly 90 percent through the tunnel and gives lock-screen play without a wedged video element. Needs a real iPhone test first.
2. **banter: reactions** (iMessage/Discord parity). Long-press or tap a bubble for a small emoji set. Reply and delete now exist, so reactions are the next thing a real chat lacks. Small server change (a reactions map per message).
3. **banter: web push for new messages** (the missing half of unread). Badges only help if the app is open. Needs service worker and VAPID keys on the box; fine on free tier, but iOS needs the app added to the home screen.
4. **browse: history + recently closed** (still unbuilt from earlier lists). Free to collect, no bookmarking effort.
5. **hub: one-line status for every app** (Arc-style start page). Banter and jetstream already report; add amp (now playing) and sage (last chat) the same way.

Order I would pick: 1, 2, 4. All wait for Luke. Nothing here is built.

## Sat Oct 3 - thinking hour (2 AM)

Grounded in: what shipped since the last list (downloads panel, uBlock Origin lists, terminal tint, recents, history, audio-only, reader, quality picker) and tonight smoke sweep. Reveal is at 1 PM, so none of this is for before then. Nothing is built.

1. **browse: per-site "allow ads" switch** (Brave shields, uBlock per-site). The bigger uBO list now triggers anti-adblock walls on some sites (rd.com showed one in QA). One tap in the toolbar to let a site through, remembered per device. Fixes the one new downside of the list Luke asked for.
2. **command palette** (Arc, Linear, Spotlight). Ctrl/Cmd-K from any app: jump to an app, a Browse tab, a recent search, or a setting. His layouts already differ per mode; the palette is the one thing that is the same everywhere.
3. **search: bangs** (Kagi/DDG). Still unbuilt from the Oct 1 list. "!w cats" goes straight to the site, which makes the search box the front door of the proxy.
4. **banter: reactions** (iMessage/Discord). Still unbuilt from the Oct 2 list. Reply, delete and unread exist, so reactions are the next missing basic.

Order I would pick: 1, 2, 4. All wait for Luke.
