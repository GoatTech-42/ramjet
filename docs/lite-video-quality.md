# Shortcut numeric video quality

`/api/lite/video?id=VIDEO_ID&q=1080` accepts plain numeric360/480/720/1080. Missing q defaults480; invalid explicit q returns JSON400 before resolving. Add info=1 to inspect requested q, actual chosen short-side height, known available H.264+AAC pair qualities, fallback_quality360, duration and estimated bytes. A video without the requested tier uses the highest available tier below it, never upscales; info reports actual chosen tier. Fallback360 names the legacy mux fallback target, not a guarantee that upstream has it.

All four are finished H.264+AAC MP4 downloads. Lite preserves <=1080 H.264 formats without the old highest12-format truncation, including adaptive360. Web playback picks are untouched. Existing15minute/150MiB caps and one serial nice ffmpeg remux remain; final muxed output is now checked against cap before publishing, and old oversized cached files are rejected by the route too. No transcode/CPU upscale.

An installed Shortcut must pass q in its video URL; backend changes do not edit its actions. Current numeric q values remain compatible. Box must verify real info and short downloaded file ffprobe video codec/short-side/audio for all four tiers, unavailable tier downgrade, invalid q JSON, size/time caps, and app regression before deployment.
