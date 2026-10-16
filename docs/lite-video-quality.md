# Shortcut numeric video quality

`/api/lite/video?id=VIDEO_ID&q=1080` accepts plain numeric 360/480/720/1080. Missing q defaults 480; invalid explicit q returns JSON 400 before resolving.

Two different height sets, kept distinct on purpose:

- **Requested tiers** are only the four API values above. q names an intent, never a guarantee.
- **Usable source heights** are the per-video H.264 short-side heights the normalizer keeps: direct https video-only avc1 formats with a finite short side from 144 through 1080, best first, capped at 16 entries. Formats with no real dimensions, heights outside that window, other codecs, muxed audio, or manifests never enter the list. `info=1` reports them as `available_qualities` (intersected with the four tiers, descending).

The planner picks the exact requested tier when usable, otherwise the highest usable tier *below* the request - never a taller one. When no adaptive tier fits, the fallback is a real muxed H.264+AAC candidate whose dimensions and codecs come from the resolver: the planner picks the best muxed format at or below the request, reports its actual height (`mode: "itag18"`, `height` = actual), and refuses upward or unsupported pairings (`mode: "unavailable"`, route answers JSON 502). `info=1` reports requested `q`, actual `chosen_quality`, `available_qualities`, and `fallback_quality` = the actual fallback height when the fallback engaged, null otherwise.

Downloads go through a hardened range fetcher: DNS-pinned public-IP-only requests (loopback/private ranges rejected), at most 5 validated redirects, https only, a strict 206 Content-Range match on both interval and total per chunk, streaming per-chunk and cumulative byte caps enforced before any write, zero-progress chunks retried then failed, and a bounded total deadline. It returns bytes actually written, never the claimed total.

All four are finished H.264+AAC MP4 downloads. Web playback picks are untouched. Existing 15 minute / 150 MiB caps and one serial nice ffmpeg remux remain; remuxed output is size-checked against the cap after the ffmpeg pass (parts are capped individually, the combined file is what matters), and oversized cached files are rejected by the route too. No transcode/CPU upscale.

An installed Shortcut must pass q in its video URL; backend changes do not edit its actions. Current numeric q values remain compatible. Box must verify real info and short downloaded file ffprobe video codec/short-side/audio for all four tiers, unavailable tier downgrade, invalid q JSON, size/time caps, and app regression before deployment.
