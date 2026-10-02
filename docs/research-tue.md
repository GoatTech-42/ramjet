# Tuesday lane research (started Mon 4:51 PM)

## browse (proxy browser)
- Pro standard for filter-safe browsing: TitaniumNetwork stack. Ultraviolet (deprecated) -> succeeded by Scramjet. Service worker intercepts requests, BareMux/Epoxy transport, server does the fetching.
- Two architecture options:
  a) SERVICE-WORKER proxy (Scramjet-style): what the pros use; handles heavy JS sites (YouTube, Discord web); more moving parts, needs careful CSP/wisp setup.
  b) SERVER-SIDE rewriting proxy: simpler, server fetches + rewrites HTML/links/assets; breaks on heavy JS apps; fine for reading/simple sites.
- Decision point Tuesday: try (a) first since YouTube-in-browser is the actual use case at school. Fallback (b) for a "reader mode".
- Budget note: proxy bytes count against the 64 MiB/hr/user budget - video through browse could blow it; jetstream exists so video does NOT need to go through browse.

## jetstream (watch anything)
- No-key YouTube search exists: InnerTube (youtubei/v1/search) - what Invidious/Piped/yt-search-lib all use. No API key, JSON results.
- Playback options: youtube-nocookie embed (simplest, official, reliable), or Invidious/Piped public instances (fragile, instances die).
- Spin ideas: audio-only mode (background play on mobile - Invidious has this, users love it), watch-later list saved to account, "play it for the room" link sharing to banter later.
