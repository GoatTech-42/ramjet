# Ponytail cleanup log

Rule for every change: behavior stays identical, one small commit each, tests before anything goes live.
Work happens on the ponytail-redo branch in a separate worktree (~/ponytail-redo/ramjet). Live containers are untouched until tests pass.

- Jetstream: removed pickHd, nothing called it.
- Lite: dropped unused readFile import.

- 8:30 PM: scanned jetstream, amp, banter, lite and core/index.js for functions referenced only once (dead code). None found. Next slice: look for duplicated helpers across addons.

- 9:31 PM: esc() was copied in lite.js and reader.js. Now one copy in util.js. Output checked on a sample string. Not deployed; needs the regression run with the other slices. getThumb in lite and jetstream are different code, left alone.
- 11:26 PM scan: only same-named function across core is getThumb (jetstream vs lite), different jobs. No duplicate helper left to merge. Next: look at unused exports.
- 1:27 AM unused-import scan of core: only aliased imports flagged, all aliases used. Nothing to cut.

- 6:29 AM: scan of jetstream, core/index.js, amp for commented-out code: none (2 comments are real notes). Next: function-length review of jetstream, one function per slice.
- 7:29 AM: unreferenced top-level functions in jetstream: none.
- 12:50 PM: resolveViaYtdlp picked the 1080 video and vp9 tracks with two copies of the pickCap logic. Both now call pickCap (same result, including null when no format). Syntax checked; needs the regression run.
- 12:55 PM: resolveViaYtdlp built the hd, hdVp9, hdL and hdLVp9 entries with four copies of one expression. Now one hdOf helper, same output. Syntax checked; needs the regression run.
- 1:00 PM: the try/cancel-response-body line was pasted 10 times in jetstream (gvProxy and the stream cache). Now one dropBody helper, same behavior. Syntax checked; needs the regression run.
- 1:05 PM: code comments in core/ and web/src named the owner and quoted chat. Reworded to plain technical comments, comments only. Syntax checked on all changed js files; needs the regression run.
- 1:10 PM: three JSON tree walkers (amp ymSearch, jetstream x2) looped over children and special-cased arrays. walk() already ignores non-objects and walks arrays, so each is now Object.values(node).forEach(walk). Same traversal order. Syntax checked; needs the regression run.
- 1:15 PM: lite.js imageSearch only forwarded its four args to searxImages. Removed the wrapper, caller uses searxImages directly. Syntax checked; needs the regression run.
