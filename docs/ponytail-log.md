# Ponytail cleanup log

Rule for every change: behavior stays identical, one small commit each, tests before anything goes live.
Work happens on the ponytail-redo branch in a separate worktree (~/ponytail-redo/ramjet). Live containers are untouched until tests pass.

- Jetstream: removed pickHd, nothing called it.
- Lite: dropped unused readFile import.

- 8:30 PM: scanned jetstream, amp, banter, lite and core/index.js for functions referenced only once (dead code). None found. Next slice: look for duplicated helpers across addons.
