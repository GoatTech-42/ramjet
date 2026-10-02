# ramjet feature notes (post-rebuild additions)

All four features store per-account state as small JSON files in data/,
written atomically (write tmp, rename). Every write validates input
server-side; ids are re-checked against the owning account on every call.

## amp playlists (data/amp-playlists.json)
- Routes: GET/POST /api/apps/amp/playlists, GET /playlists/tracks?id=,
  POST /playlists/add|remove|rename|delete.
- Track objects are the search-result shape, revalidated per source
  (yt 11-char id, sc numeric, au alnum) and stream URLs are rebuilt
  from src+id on save - nothing client-made is trusted.
- Caps: 20 playlists, 100 tracks each. Duplicates merge silently
  ("already in <name>").

## jetstream keep watching (data/jetstream-history.json)
- Routes: GET/POST /api/apps/jetstream/history, POST /history/delete.
- Client records a video only after its stream resolves. Newest first,
  rewatching moves it to the front, cap 25 (shelf shows 10).

## browse bookmarks (data/browse-bookmarks.json)
- core/addons/browse exists only for bookmarks - the proxy itself is
  client-side scramjet.
- Routes: GET/POST /api/apps/browse/bookmarks, POST /bookmarks/delete.
- URL must be public http(s), no creds; name comes from the live page
  title, hostname as fallback. Cap 30.

## sage conversations (data/sage-conversations.json)
- Routes: GET/POST /api/apps/sage/conversations, GET
  /conversations/messages?id=, POST /conversations/delete,
  POST /conversations/clear (used by the settings two-tap delete-all).
- Titles come from the first user message. Cap 20 conversations,
  100 messages each.
- Client-side generation guard: a model reply only lands in the chat
  it started in (switching chats mid-reply drops the stale response).

## settings centralization (Luke, Sep 29)
Anything settings-like lives on the settings page, not inside apps.
Today: account, change password, sage delete-all conversations, log out.

## jetstream shorts + for you (Tue 3:10 PM)
- One recommendation engine (Luke: "shorts should work off the same algorithm"): seeds from the account watch history (top channels, then title keywords) mixed with broad seeds; candidates from InnerTube (plain + " shorts" phrasing per seed), scored by channel match + keyword overlap + views, deduped, watch-history excluded, jitter so refreshes are not frozen. Cached 10 min per account.
- /api/apps/jetstream/shorts = the short-form slice (<= 61 s), /api/apps/jetstream/for-you = the rest. Same ranked list, two shelves.
- Shorts feed UI: full-screen vertical snap-scroll, one short per screen, tap to play/pause, big play button when paused, per-slide error with tap-to-retry. Only the visible slide and the next hold a stream; slides farther away drop their source so a long session cannot burn the hourly byte budget. Playback reuses the metered /watch + /stream path, so the 1GB/hr guard applies unchanged; a 429 shows the out-of-bandwidth message on the slide.
- Watched shorts record into the same keep-watching history, which feeds the algorithm.

## privacy: per-app sections in ramjet settings (Tue 3:10 PM, Luke delegated the calls)
- jetstream: pause/resume watch history (recording stops, saved list stays), clear keep watching (two-tap), count + status shown. Single-video removal stays on the jetstream shelf. Data: data/jetstream-settings.json.
- sage: delete all conversations (existing, two-tap).
- amp: delete all playlists (new route /playlists/clear, two-tap).
- browse: clear all bookmarks (new route /bookmarks/clear, two-tap).
- All history/bookmarks/playlists/chats are per-account server-side, so every device sees the same state and clearing applies everywhere.
- PATH BUG FOUND + FIXED: jetstream HIST_FILE still pointed at core/data (same class of bug as sage earlier); moved to ../../../data/ and core/data deleted. Entries recorded between 1:35 and 3:08 PM lived in the wrong file and were removed with it (qa test data; possibly a few of Luke's own keep-watching items from this afternoon).

## shorts zone (Tue 3:32 PM)
- The shorts feed is a real zone now: its own search bar up top (short-form results only, ranked by the same engine as for-you), a "back to for you" chip to leave search mode, and a like button on every slide.
- Likes are the strongest ranking signal: a like counts double vs a view in the profile (channels + title words), liked videos leave the feed, and liking instantly reshapes your for-you (rec cache invalidated on toggle).
- Ranking upgrades across the board: view-count parsing actually handles 1.2M/340K suffixes now (it used to score "1.2M" as 1.2 views), a freshness bonus (<=24h > week > month), and channel diversity (max 3 per channel before overflow).
- Home gets a "start scrolling" entry next to the shorts shelf header.
- New routes: GET /api/apps/jetstream/shorts?q=, GET /api/apps/jetstream/likes, POST /api/apps/jetstream/likes/toggle. Data: data/jetstream-likes.json (per account, cap 100).

## not interested (Tue 3:52 PM)
- The like button got its negative twin: thumbs-down on every short. Marking one slides you to the next short right away, the video never comes back, and the ranking engine sinks that channel plus its title words against every future candidate (for-you, shorts, and shorts search). Undo any time from the same button.
- New routes: GET /api/apps/jetstream/dislikes, POST /api/apps/jetstream/dislikes/toggle. Data: data/jetstream-dislikes.json (per account, cap 100).

## scroll performance + shelf sizing (Tue 4:26 PM)
- Shorts scrolling reworked after real-world lag report: every visited slide used to keep its video stream (decoder) alive - 13 live decoders after 12 swipes. Now a hard sweep on every slide activation keeps only the active slide and the next prebuffer; streams stay flat no matter how long you scroll.
- Format picker drops 60fps to 30fps only at the same resolution (never trades pixels for frames); chain-swipe insurance warms the resolve for the slide after next.
- Home shorts shelf: cards are a fixed 172px tall (were free-height and could blow up to ~700px before styles settled) - compact portrait cards, ~4 per row on a phone.

## keep watching rules + feed refresh + clear history (Tue 4:31 PM)
- Keep watching behaves like a shelf now: entries age out after 3 days, shorts never sit on it, and a video watched to the end marks itself complete and leaves. The full history still trains your feeds - only the shelf filters.
- The shorts feed refreshes: every feed open re-ranks fresh, and landing on the last slide quietly pulls the next batch (endless). Likes, dislikes, and history clears already reshaped it instantly.
- Settings > jetstream now says what it does: "clear watch history" wipes the whole history AND resets what your feeds learned (the button existed but was mislabeled "clear keep watching").
- Client telemetry: every slide reports what the device actually rendered (dimensions, hd/muxed, ua) to data/jetstream-clientlog.jsonl - real quality numbers from real phones, not emulation.

## feed variety + speed pass (Tue 4:42 PM)
- Your shorts feed actually changes now: every new batch is shorts you have not been served yet, and the recommender rotates through a wider window of your taste (channels + title words) so re-ranks explore instead of freezing on the same top picks.
- Opens are instant: the feed answers from the ready batch and builds the next one behind the scenes. First open after a while still does one fresh build (under a second).
- One taste across both feeds: your whole watch history (long-form included, 200-entry memory) plus likes train both the shorts feed and the for-you shelf. Watching a documentary tonight shows up in your shorts tomorrow.

## shorts seek bar (Tue 4:55 PM)
- Shorts have a real progress bar now: a thin line along the bottom of every slide fills as it plays, and tapping anywhere on it jumps there - the synced HD audio jumps with it. Same as YouTube's.

## stutter fix (Tue 5:11 PM)
- Video and audio stay in lockstep by ear, not by jumps: the player now nudges the audio's speed up or down a hair to match the video instead of hard-jumping it (every hard jump re-buffered the audio and dropped the sound for a beat - that was the constant stutter). A real desync past a second and a half still snaps straight. Same fix in the big player.
