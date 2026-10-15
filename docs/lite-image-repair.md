# Shortcut image repair

Based on running4d75f75 tree. Qwant exact request403 bot challenge confirmed locally and on box. User chose source flexibility after DDG/Qwant question. Shortcut image routes now use unofficial DDG token/i.js flow with fixed UA, bounded responses/timeouts,100 native page offsets, safe mode cookies/params from current native engine. Provider token/JSON calls EACH pass shared persisted24/10min,3sec admission and10min failure cooldown. No captcha bypass/retries/fallback. Token TTL10min in memory; image page cache30min/negative60sec,100entries/8MiB private file. DDG cache/budget separate from retired Qwant so stale failures do not leak across providers.

Success JSON fields unchanged, source is duckduckgo. Errors remain502 with code distinguishing provider_blocked/provider_rate_limited/cooldown/provider_invalid/network/unavailable and upstream_status where known; external challenge URLs/body are never returned. Thumbnail fetch stays existing SSRF-safe pinned/redirect-checked code. Media fallback permits only exact external-content.duckduckgo.com in addition to existing hosts.

Local real proof: imgsearch20020 rows, thumbnail200JPEG, imgsheet2008 numbered images. Box must Docker-build and verify same from its egress before declaring fixed. Undocumented DDG can still block. Safe filtering request mapping checked in fixtures, not a guarantee of image content. Existing paging requests native pages and truncates per requested size, unchanged model.

Source: https://raw.githubusercontent.com/searxng/searxng/master/searx/engines/duckduckgo_extra.py
