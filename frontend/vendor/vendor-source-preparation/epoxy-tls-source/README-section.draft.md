# draft README section for vendor/vendor-source-preparation/README.md

## epoxy-tls wasm source (epoxy-tls-source/)
- epoxy-tls-93d5a726-source.tar.gz: preferred-source lead for the net.wasm binary
  (npm @mercuryworkshop/epoxy-tls 2.1.19-1 full variant). sha256 and provenance in
  epoxy-tls-source/PROVENANCE.md; build recipe in epoxy-tls-source/BUILD-NOTES.md (unexecuted).
- deps/: vendored archives of the two Cargo.lock git pins (h2-wasm, hyper-util-wasm, both MIT).
- version status (hypothesis, not proof): 2.1.19-1 may be source at 93d5a726 plus an uncommitted
  publish-time version bump; other uncommitted local changes cannot be excluded from public
  evidence. do not state binary/source identity beyond what PROVENANCE.md supports.
- AGPL-3.0-only. the production source offer must reach a commit/packet containing this directory.
