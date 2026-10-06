# Ponytail cleanup log

Rule for every change: behavior stays identical, one small commit each, tests before anything goes live.
Work happens on the ponytail-redo branch in a separate worktree (~/ponytail-redo/ramjet). Live containers are untouched until tests pass.

- Jetstream: removed pickHd, nothing called it.
- Lite: dropped unused readFile import.

- 8:30 PM: scanned jetstream, amp, banter, lite and core/index.js for functions referenced only once (dead code). None found. Next slice: look for duplicated helpers across addons.

- 9:31 PM: esc() was copied in lite.js and reader.js. Now one copy in util.js. Output checked on a sample string. Not deployed; needs the regression run with the other slices. getThumb in lite and jetstream are different code, left alone.
- 11:26 PM scan: only same-named function across core is getThumb (jetstream vs lite), different jobs. No duplicate helper left to merge. Next: look at unused exports.
