# Ponytail cleanup log

Rule for every change: behavior stays identical, one small commit each, tests before anything goes live.
Work happens on the ponytail-redo branch in a separate worktree (~/ponytail-redo/ramjet). Live containers are untouched until tests pass.

- Jetstream: removed pickHd, nothing called it.
- Lite: dropped unused readFile import.
