# owned source-built full-variant epoxy pair - qualified pipeline candidate (EXPERIMENTAL, not for shipping)

what this is: a glue+wasm PAIR built from pinned source by the documented working recipe (rebuild/RESULT.md,
adaptation-PR146317-flags.patch). the pair is self-consistent by construction: the glue provides exactly the
imports its wasm requests. files: epoxy.js / epoxy.wasm / epoxy.d.ts / epoxy-bundled.js / epoxy-bundled.d.ts (.EXPERIMENTAL).

why a PAIR, not a wasm swap: the npm-carried glue (123-import schema) cannot drive this wasm (122-import schema) and
vice versa - import names differ at schema level (see rebuild/RESULT.md raw deltas). any adoption must move glue+wasm
together and rebuild the transport bundle against them.

pins (all actual): source MercuryWorkshop/epoxy-tls @ 93d5a726894b2f16bad54c4a3801446cbbd22d26 + adaptation patch
(flags only, no source change); Cargo.lock sha256 45e0f6ba... (--locked); rustc 1.94.0-nightly a6525d526 (2025-12-21);
wasm-bindgen CLI 0.2.100 (crate 0.2.100 via lock); wasm-opt binaryen version_125; clang 18.1.8; libtinfo5 compat.
cache provenance: incremental cargo cache across two invocations of the identical command (see custody receipt).

glue API compatibility vs the npm glue (measured):
- named exports: IDENTICAL set (init/default, EpoxyClient, EpoxyClientOptions, EpoxyWispTransport, info, etc.)
- EpoxyClient method surface: identical modulo one internal helper (__wbg_init_memory present in owned glue)
- info const (owned, unpatched baseline): { version: "2.1.18-1", minimal: false, release: true, commit: "93d5a726..." }
- wbg import schema: DIFFERS from npm glue (schema-level, not suffix-only) - pair must move together

transport integration recipe (actual, from the transport's own build - no invented adapters):
- @mercuryworkshop/epoxy-transport 3.0.1 depends on "@mercuryworkshop/epoxy-tls": "2.1.19-1" and builds via
  `node esbuild.bundle.mjs` (its package.json build script). its dist/index.mjs bundles the epoxy-tls full glue inline
  and references the wasm exactly once via new URL("epoxy.wasm", import.meta.url) (the stitch aliases epoxy.wasm->net.wasm).
- candidate recipe: (1) stage the owned pkg/ files as the resolved @mercuryworkshop/epoxy-tls package (full/ variant);
  (2) run the transport's own `npm run build` against it, producing a new dist/index.mjs embedding the owned glue and
  referencing the owned wasm; (3) existing stitch rules apply unchanged. the transport's dependency version string
  would need to match the staged owned package (a packaging decision, not made here).

remaining gaps before ANY adoption (none closed here): independent ABI review of the pair; actual local Chrome engine
run (Epoxy init + bounded network fixture + browse QA); transport rebuild QA against the owned pair; licenses/source-offer
routing for the new artifacts; Main's adoption decision. correspondence of this pair to the npm binary remains unproven.
