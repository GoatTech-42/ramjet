# option-2 adapted rebuild - actual result (2026-10-30)

setup (all versions actual and captured): source = fresh clone at 93d5a726894b2f16bad54c4a3801446cbbd22d26
(unmodified baseline; only client/build.sh flags migrated per adaptation-PR146317-flags.patch),
Cargo.lock sha 45e0f6ba... (--locked enforced), toolchain nightly-2025-12-22 (rustc 1.94.0-nightly a6525d526 2025-12-21),
wasm-bindgen CLI 0.2.100, wasm-opt binaryen version_125, clang 18.1.8 (official LLVM release binary; host has no clang -
ring 0.17.14 builds C code), libtinfo5_6.3-2ubuntu0.3 compat lib (host has only libtinfo6).

flag migration (documented, per rust PRs 146317/147470): drop panic_immediate_abort from
-Zbuild-std-features (keep optimize_for_size); add -Zunstable-options -Cpanic=immediate-abort to RUSTFLAGS.
exact diff in adaptation-PR146317-flags.patch. no version patch applied (package.json stayed 2.1.18-1).

result: BUILD SUCCEEDED (BUILD_EXIT=0; full RELEASE variant incl. wasm-opt converge chain; log in adapted-build.log).
produced pkg/epoxy.wasm = sha256 337afcb070c1e397cb1b7c2359a1cc88ac79a8bf03a438019836e5fc3120b7fd, 1,264,066 B.
BYTE COMPARISON vs npm full/epoxy.wasm (4e26f08f..., 1,267,216 B): MISMATCH.
per the pre-set rule this is INCONCLUSIVE: it does not close binary/source correspondence and does not disprove it
(the publisher's rustc/flags remain unknown; codegen and wasm-bindgen hash suffixes vary with toolchain).

raw deltas only (NOT a correspondence claim, NO semantic identity claimed): built module imports=122 exports=77;
npm module imports=123 exports=77. name differences are schema-level, NOT hash-suffix-only. examples:
__wbg__wbg_cb_unref (npm) vs __wbindgen_cb_drop (built); __wbg_isArray vs __wbindgen_is_array;
__wbg_ws_key vs __wbg_wskey; __wbg_convert_body_inner vs __wbg_convertbodyinner.
hypothesis (unverified): build.sh does not pass --locked upstream, so a 2025-12-22 publish-day build would resolve
wasm-bindgen crate 0.2.106 (newest that day; 0.2.105 released 2025-10-27, 0.2.106 2025-11-28) rather than the locked
0.2.100 used here; a wasm-bindgen schema change between those versions could produce these deltas. not confirmed in
wasm-bindgen's changelog; the publisher's actual dep resolution is unknown.

status of epoxy.wasm.EXPERIMENTAL-not-a-replacement: experimental evidence only. it is NOT a candidate replacement
for the carried binary and MUST NOT ship without independent ABI/behavior review, actual browse QA, and source-offer routing.
