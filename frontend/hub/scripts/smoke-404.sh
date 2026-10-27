#!/usr/bin/env bash
# smoke-404: the shell must degrade to designed empty/error states, never white
# screens or console error spam. Covers live-by-default against a stubbed
# /api/lite answering ok:true and ok:false, plus mock self-containment (mock
# mode must render full content while the API stub answers 404 to everything).
# Usage: scripts/smoke-404.sh   (expects `npm run build` already done)
set -u
TMP=$(mktemp -d)
node "$(dirname "$0")/serve-stub.mjs" dist 4181 ok  >"$TMP/ok.log" 2>&1 & OKPID=$!
node "$(dirname "$0")/serve-stub.mjs" dist 4182 fail >"$TMP/fail.log" 2>&1 & FAILPID=$!
trap 'kill $OKPID $FAILPID 2>/dev/null; rm -rf "$TMP"' EXIT
sleep 1

fails=0
run() { google-chrome --headless=new --disable-gpu --hide-scrollbars --virtual-time-budget=4000 \
  --enable-logging=stderr --dump-dom "$1" >"$TMP/dom.html" 2>"$TMP/console.log"; }
assert() { # label url must-present must-absent-or-empty
  run "$2"
  if ! grep -q "$3" "$TMP/dom.html"; then echo "FAIL $1: '$3' missing"; fails=1
  else echo "ok   $1: '$3'"; fi
  if [ -n "${4:-}" ] && grep -q "$4" "$TMP/dom.html"; then echo "FAIL $1: unexpected '$4' present"; fails=1; fi
  if grep -qiE 'uncaught|unhandled|failed to load|net::ERR' "$TMP/console.log"; then
    echo "FAIL $1: console error spam:"; grep -iE 'uncaught|unhandled|failed to load|net::ERR' "$TMP/console.log" | head -5; fails=1
  fi
}

for pair in '/:home' '/browse:browse' '/jetstream:watch' '/settings:settings'; do
  p="${pair%%:*}"; r="${pair#*:}"
  case $r in
    home) m='type a site or a search';; browse) m='public domain day 2026';;
    watch) m='up next';; settings) m='appearance';;
  esac
  assert "live-ok   $r" "http://localhost:4181$p?skin=dark" "$m"
  assert "live-404  $r" "http://localhost:4182$p?skin=dark" "$m"
  assert "mock-404  $r" "http://localhost:4182$p?mocklite=1&skin=dark" "$m"
done
# fonts must be served through the r32 prefix gate (hashed /assets/, never /fonts/)
for f in $(grep -o '/assets/[^)]*\.woff2' dist/assets/*.css | sed 's/.*://' | sort -u); do
  code=$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:4181$f")
  [ "$code" = 200 ] && echo "ok   font 200: $f" || { echo "FAIL font $f -> $code"; fails=1; }
done
# and the old /fonts/ path must NOT exist anymore
code=$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:4181/fonts/IBMPlexSans-var.woff2")
[ "$code" = 404 ] && echo 'ok   /fonts/ gated to 404' || { echo "FAIL /fonts/ served ($code)"; fails=1; }
assert 'live-ok   watch rows'      'http://localhost:4181/jetstream?skin=dark' 'class="nxrow'
assert 'live-404  watch empty'     'http://localhost:4182/jetstream?skin=dark' 'nothing up next' 'class="nxrow'
assert 'mock-404  watch rows'      'http://localhost:4182/jetstream?mocklite=1&skin=dark' 'class="nxrow' 'nothing up next'
[ $fails -eq 0 ] && echo 'SMOKE PASS' || echo 'SMOKE FAIL'
exit $fails
