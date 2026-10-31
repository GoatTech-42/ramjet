# epoxy-tls full-variant build recipe (CANDIDATE, NOT a verified working recipe)

STATUS: the publish-day-nightly attempt at this recipe FAILED at core compile (see PROVENANCE.md section 3 and rebuild-attempt-build.log / rebuild-core-error.txt in this directory): nightly >= 2025-09-24 rejects -Zbuild-std-features=panic_immediate_abort (rust PR 146317). do not treat this document as a working recipe.

entry point: client/build.sh (no root build.sh). full variant = MINIMAL unset. release variant = RELEASE=1 (the shipped binary).

prerequisites:
- rustup toolchain: channel "nightly" per rust-toolchain.toml (UNDATED upstream). ATTEMPTED AND FAILED: nightly-2025-12-22 fails at core compile per the status note above. a working attempt needs either a nightly older than ~2025-09-24, or the flag adaptation: drop panic_immediate_abort from -Zbuild-std-features (keep optimize_for_size), keep -Zbuild-std=panic_abort,std, and add -Zunstable-options -Cpanic=immediate-abort to RUSTFLAGS (equivalence basis: PR 146317 states the new flag codifies the old feature with no other impacts - unverified upstream claim; acceptance for any correspondence claim = byte-exact match to the npm binary).
- rustup component add rust-src; rustup target add wasm32-unknown-unknown
- wasm-bindgen CLI EXACTLY 0.2.100 (build.sh hard-fails otherwise)
- wasm-opt (binaryen). version UNPINNED upstream; record the version used.
- jq, base64

steps:
1. git clone https://github.com/MercuryWorkshop/epoxy-tls && cd epoxy-tls
   git checkout 93d5a726894b2f16bad54c4a3801446cbbd22d26
   (a real clone checkout, so build.sh's git rev-parse HEAD embeds genuine identity; never fake git metadata)
2. npm-parity ONLY (optional, deliberate, documented): set client/package.json version to 2.1.19-1 to match the published info.version string. this mirrors the inferred publish-time bump; it is an explicit patch step, not a silent dirty edit.
3. cd client && RELEASE=1 ./build.sh --locked
   (MINIMAL unset => full variant with default features; "$@" forwards --locked to cargo, enforcing Cargo.lock)
4. compare pkg/epoxy.wasm against the npm tarball full/epoxy.wasm
   (sha256 4e26f08ff06635cddc70b4449145490fd9a00b01fbfe318c2f62b0d22800508e).
   byte-identity closes the correspondence question for the wasm; a mismatch with matching imports/exports/sections corroborates but does not prove it.

generated-artifact transforms applied by build.sh (present in the shipped glue): snippet base64 embedding, Safari memory-limit patch, epoxy_client.wasm -> epoxy.wasm rename, initSync export removal. these are part of the preferred-source pipeline, not post-hoc edits.
