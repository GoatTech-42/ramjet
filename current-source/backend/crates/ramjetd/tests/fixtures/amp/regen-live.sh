#!/usr/bin/env bash
# Regenerate oracle goldens from REAL payloads captured on the rig, then run the Rust parsers against them.
# usage: regen-live.sh <captures-dir> <r32-amp-addon.js> [out-dir=./live-oracle]
#   captures-dir holds raw upstream responses named  yt-<tag>.raw.json  sc-<tag>.raw.json  au-<tag>.raw.json
#   (any subset per tag). <tag> groups the three sources of one query into one case. See amp-live-probe-runbook.md 1.A.
# Needs: node, jq, cargo (run from anywhere; paths are resolved). Writes nothing outside <out-dir>.
set -euo pipefail
CAP=$(cd "$1" && pwd); R32=$(cd "$(dirname "$2")" && pwd)/$(basename "$2"); OUT=${3:-./live-oracle}
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
mkdir -p "$OUT/cases" "$OUT/golden"; OUT=$(cd "$OUT" && pwd); rm -f "$OUT"/cases/*.json "$OUT"/golden/*.json
[ -f "$R32" ] || { echo "r32 source not found: $R32" >&2; exit 2; }
ok=0; skip=0; : > "$OUT/skipped.txt"
declare -A tags
for f in "$CAP"/{yt,sc,au}-*.raw.json; do [ -e "$f" ] || continue; b=$(basename "$f" .raw.json); tags[${b#*-}]=1; done
[ ${#tags[@]} -gt 0 ] || { echo "no captures matching {yt,sc,au}-<tag>.raw.json in $CAP" >&2; exit 2; }
for tag in "${!tags[@]}"; do
  args=(); filt='{}'
  for src in yt sc au; do
    f="$CAP/$src-$tag.raw.json"; [ -e "$f" ] || continue
    # a capture that is not JSON (consent wall, captcha HTML, empty) is skipped and reported, never guessed at
    if jq -e . "$f" >/dev/null 2>&1; then args+=(--slurpfile "$src" "$f"); filt="$filt + {\"$src\":\$$src[0]}"; ok=$((ok+1))
    else echo "$src-$tag: not JSON ($(wc -c <"$f") bytes) - skipped" >> "$OUT/skipped.txt"; skip=$((skip+1)); fi
  done
  [ ${#args[@]} -gt 0 ] && jq -nc "${args[@]}" "$filt" > "$OUT/cases/live-$tag.json"
done
( cd "$HERE" && node gen.js "$R32" "$OUT/cases" "$OUT/golden" )
echo "captures used: $ok, skipped: $skip (see $OUT/skipped.txt)"
echo "THROW goldens (r32 rejects the payload):"; grep -l '^THROW$' "$OUT"/golden/*.json 2>/dev/null || echo "  none"
# Rust parsers vs r32 goldens. A diff here is r32 reality to FLAG, not to patch.
( cd "$HERE/../../../../.." && RJ_ORACLE_DIR="$OUT" cargo test -p ramjetd --test amp_media oracle_goldens_vs_r32 -- --nocapture ) && echo "LIVE ORACLE: parity holds on $(ls "$OUT"/golden | wc -l) real-payload goldens"
