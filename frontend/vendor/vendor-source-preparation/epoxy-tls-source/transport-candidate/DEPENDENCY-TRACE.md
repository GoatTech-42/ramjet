# transport 3.0.1 candidate built on the owned epoxy pair (EXPERIMENTAL, not for adoption)

pipeline: @mercuryworkshop/epoxy-transport 3.0.1 own build (node esbuild.bundle.mjs, ESM+CJS+d.ts), run unmodified.
resolved dependency (explicit local override, NOT the npm release): @mercuryworkshop/epoxy-tls = file:../epoxy-tls-owned,
  a locally staged package versioned 2.1.18-1+owned.93d5a726 containing the owned full-variant pair
  (source MercuryWorkshop/epoxy-tls @ 93d5a726894b2f16bad54c4a3801446cbbd22d26 + rebuild/adaptation-PR146317-flags.patch,
  Cargo.lock --locked sha 45e0f6ba..., rustc 1.94.0-nightly a6525d526 2025-12-21, wasm-bindgen CLI 0.2.100,
  binaryen version_125, clang 18.1.8). no version bump, no npm-release relabeling: generated info preserved as
  { version: "2.1.18-1", minimal: false, release: true, commit: "93d5a726..." }.
toolchain resolution note: dts-bundle-generator is incompatible with today's typescript@7 default; typescript@5 was
  pinned explicitly as a devDependency for this build (documented toolchain pin, no source/semantics change).
  esbuild per transport devDeps (^0.25.8) + esbuild-plugin-d.ts ^1.3.1 + esbuild-plugin-umd-wrapper ^3.0.0.

outputs (hashes):
  index.mjs  f26cdf17e9f57a91ed39c5a92939de4a5c66aac1115cd2b1bb2a92c9c9db8b22  (1,738,295 B)
  index.js   8d0d1c197eee3ef873040259ffd1c2549f2dc31b81f1a6577d914dfdd16be576  (1,739,961 B)
  index.d.ts f0f3deea16f37ba273da18a0b7dabd968e13e3abe8b99ec499ce12037b0cd88b  (1,405 B)
  paired wasm asset (owned): 337afcb070c1e397cb1b7c2359a1cc88ac79a8bf03a438019836e5fc3120b7fd (1,264,066 B)

verification (measured on index.mjs):
  - embedded base64 wasm decodes to sha256 337afcb0... = the OWNED wasm (pair travels together; no old-npm bytes)
  - owned glue schema marker present; generated info version "2.1.18-1" present; ZERO occurrences of "2.1.19-1"
  - exactly one new URL("epoxy.wasm", import.meta.url) reference (the existing stitch alias rule would apply unchanged)
  - the r32 runtime net.wasm (old npm 4e26f08f...) is NOT part of this candidate; the paired asset is the owned wasm only

NOT done / gaps: no browser QA, no transport runtime QA, no adoption. independent pair review (122 providers / 77 exports /
Node instantiate) passed per reviewer; ABI review of the bundled artifact and actual local Chrome engine run remain open.
license/notice: epoxy-tls AGPL-3.0-only (LICENSE in owned package staging); source-offer routing unchanged from packet v5+.
