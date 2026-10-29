# ramjet offhost QA lab (generic, sanitized)
Purpose: render + transition QA of a ramjet static dist against the ramjetd backend, fully offhost.
- lab_inside.sh: boots ramjetd + fixture upstream + sidecar inside a user+mount+net namespace
  (loopback only; wisp-sidecar name bound via /etc/hosts bind-mount; no external egress).
  Env: DIST=<dist dir> MODE=desktop|mobile; run: `unshare -Urmn bash lab_inside.sh`.
- sidecar.js: reference reimplementation of the ramjet media-bridge sidecar protocol
  (WS text frame request {id,url,method,headers:[[k,v]]}; binary responses: u32be(id)+u8 type:
  0=head JSON {status,text,headers}, 1=body chunk, 2=close, 3=error utf8).
- fixture_srv.js + fixture/: controlled local upstream with marker strings + subresources.
- harness.js: desktop/mobile login + pages + SW identity + rendered-nav check (puppeteer-core + system chrome).
- harness5.js: per-file atomic-rename cutover transition test with SW/CDP instrumentation + SHA readbacks.
- harness4.js / harness6.js: mid-session SW restart (CDP ServiceWorker.stopWorker, needs versionId)
  revive-path probes, inside vs outside the vendored 5s guard window.
Fresh fixture account only (signup API, requireApproval=false in RJ_DATA/config.json). Never copy live auth.
Note: harness.js and lab_inside.sh are path-parameterized (LAB_ROOT/FIXTURE_DIR); the probe
scripts harness4/5/6.js carry the absolute lab path /tmp/fullapp in constants at the top - adjust
BASE/SHOTS/D to your layout before reuse.
