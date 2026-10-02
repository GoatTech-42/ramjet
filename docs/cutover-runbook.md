# ramjet2 cutover runbook

How to make ramjet2 the live ramjet, when Luke asks. Written Sep 29 (ahead of the Saturday reveal). Live relaunch ONLY on Luke's word.

## Current state

| piece | v1 (live ramjet, DOWN) | v2 (ramjet2, preview) |
|---|---|---|
| code | /home/luke/goattech/ramjet | /home/luke/goattech/ramjet-rebuild |
| run by | systemd user unit `ramjet.service` | manual via /home/luke/bin/rj-restart.sh |
| bind | 127.0.0.1:14204 | 0.0.0.0:14224 (see step 3) |
| tunnel | tunnel-manager "ramjet (live)" -> https://fekh6mkrjj5jy7sflu3tugbvsu.srv.us (port 14204, fwd 4201, key /home/luke/goattech/live_srvus_key) | none |

v1 has been stopped since Sep 28 2:08 PM PT (Luke's call). tunnel-manager stays running for other tunnels; do not touch it beyond step 5.

## Preconditions
- Friday acceptance gate green (10+ regression passes, both viewports, zero console errors)
- Luke has logged into the v2 preview himself and knows his password works
- data/ backup taken: `cp -r data /home/luke/goattech/ramjet-rebuild/data.bak-cutover`

## Steps
1. Create the v2 systemd user unit `~/.config/systemd/user/ramjet2.service`:
   - WorkingDirectory=/home/luke/goattech/ramjet-rebuild
   - Environment=RJ_HOST=127.0.0.1 RJ_PORT=14204 (env names verified in core/index.js: RJ_HOST, RJ_PORT, RJ_DATA; defaults 127.0.0.1:14224)
   - ExecStart=/usr/bin/node core/index.js
   - Restart=always, RestartSec=5
2. Kill the manual preview (pkill -f "core/index[.]js" - bracket trick, or the process fights the unit for the port).
3. BIND FIX: the preview currently binds 0.0.0.0 via rj-restart.sh. For cutover the unit binds 127.0.0.1 only - public traffic must come through the tunnel, not the LAN interface. Verify with `ss -ln | grep 14204` (expect 127.0.0.1, not 0.0.0.0).
4. `systemctl --user daemon-reload && systemctl --user enable --now ramjet2`
5. tunnel-manager needs no change: its "ramjet (live)" tunnel already forwards to 127.0.0.1:14204.
6. Verify through the public URL https://fekh6mkrjj5jy7sflu3tugbvsu.srv.us : login page loads, Luke's login works, all 5 pages render, sage answers (Groq), jetstream plays, amp plays.
7. `systemctl --user disable ramjet` (v1) so a reboot can't bring the old one back.
8. QA account: remove the qa user from data/users.json or rotate its password before calling it done - agents know that password.

## Rollback (v2 bad, back to v1)
1. `systemctl --user stop ramjet2`
2. `systemctl --user enable --now ramjet` (v1 code untouched at /home/luke/goattech/ramjet)
3. Tunnel is unchanged, so the public URL serves v1 again immediately. Verify edge 200.

## After cutover
- sage needs the Groq key present in the vault entry `groq-emberstead` (already set); provider file data/sage-provider.json points at api.groq.com, model openai/gpt-oss-120b.
- Guard: 1GB/user/hr bytes + 5000 req/user/hr + login throttles (10/account/10min, 120/IP/10min). data/guard.json carries the buckets.
- Watch the first hour: tunnel-manager incidents.jsonl for new rows, preview log /tmp/ramjet-preview.log (move to a unit journal once under systemd).
