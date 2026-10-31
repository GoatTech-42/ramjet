# final coherent epoxy candidate - resolved runtime paths, notices, source offer (PREPARATION ONLY, no adoption)

## 0. reconciliation to integration 8089dfa (2026-10-30)

base moved: prepared against 2e656f7, this packet now reconciles onto integration
8089dfad0cb61b698466fedd640f2703a409428d ("browse: fail fast on unsupported rj-transport
selections"). that commit touched only engine.js, Browse.svelte and the browse-boot tests -
zero file overlap with this packet; git apply onto 8089dfa verified clean, and the applied
owned pair re-verified by hash (net.wasm 337afcb0..., glue f26cdf17...). truthful build
identity of the candidate: base RepoTag ramjet2:v5e19-c74-r13i-a1491b9c + integration source
8089dfa + this packet's diff. still candidate-only: no adoption, deploy, or release claim.

completeness fixes in this revision: the corresponding-source tarballs the manifest always
listed are now actually in the tree (the epoxy-tls 93d5a726 source archive and both git-dep
archives), plus the two rebuild logs and the r32-carried LICENSE-epoxy-tls.txt (AGPL text
beside the now-tracked owned net.wasm). MANIFEST.sha256 regenerated over this exact tree:
the v9 manifest listed net.wasm as the old npm wasm (4e26f08f...) while the v9 diff already
carried the owned wasm (337afcb0...) - that stale entry is corrected here.

status: candidate custody. reviewer-verified pair (122/122 providers, 77 exports, Node instantiate PASS; bundle + stitch alias init ready true, zero fetch on no-arg init). reviewer note preserved: embedded bytes are assigned before the default new URL branch, so the fallback wasm URL is not executed on normal no-arg init - this says nothing retroactive about the OLD npm runtime, which stays unproven.

## 1. actual resolved runtime paths (the swap IS applied by this patch in the candidate tree; not adopted, published, or deployed)
base runtime at 8089dfa (unchanged there, old npm pair):
  r32/src/public/epoxy/index.mjs  <- epoxy-transport 3.0.1 npm dist (embeds npm 2.1.19-1 glue + npm wasm 4e26f08f...)
  r32/src/public/epoxy/net.wasm   <- npm full/epoxy.wasm (4e26f08f...)   [alias of epoxy.wasm via stitch]
candidate mapping this patch applies to the tree (single coherent swap, no mixed pair; adoption remains gated):
  r32/src/public/epoxy/index.mjs  <- transport-candidate/index.mjs.EXPERIMENTAL (f26cdf17e9f57a91ed39c5a92939de4a5c66aac1115cd2b1bb2a92c9c9db8b22)
  r32/src/public/epoxy/net.wasm   <- transport-candidate/net.wasm.OWNED-EXPERIMENTAL-337afcb0 (337afcb070c1e397cb1b7c2359a1cc88ac79a8bf03a438019836e5fc3120b7fd)
  notes: the stitch's counted rewrite epoxy.wasm->net.wasm applies unchanged (exactly one new URL("epoxy.wasm") in the bundle);
  the bundled glue assigns the embedded bytes before any path is read (reviewer-verified): the initializer overwrites
  module_or_path.module_or_path with the embedded bytes before destructuring, so even an explicit path is ignored and
  no-arg init never fetches net.wasm. the paired asset is carried for compat/fallback routes that are UNEXECUTED and
  unproven - its necessity is not established. types consumers use index.d.ts (f0f3deea16f37ba273da18a0b7dabd968e13e3abe8b99ec499ce12037b0cd88b).

## 2. notices (drafts; apply only to what actually ships)
current shipped NOTICE entry at 8089dfa (actual text; this patch does not edit it, it appends the separate CANDIDATE BUILD ONLY entry below):
  "* epoxy transport (r32/src/public/epoxy): @mercuryworkshop/epoxy-transport
    3.0.1, AGPL-3.0-only, with an output packaging alias (epoxy.wasm ->
    net.wasm). npm package source: vendor/vendor-source-preparation/."
  NOTICE-entry.draft.md is a DRAFT addition for source-lane review (lead-level npm 2.1.19-1 wording), not the current text.
candidate NOTICE entry (only if the owned pair is adopted):
  * epoxy transport wasm/glue: locally source-built from MercuryWorkshop/epoxy-tls @ 93d5a726894b2f16bad54c4a3801446cbbd22d26
    plus a documented flag-migration patch (rust PR 146317/147470: -Cpanic=immediate-abort replaces
    -Zbuild-std-features=panic_immediate_abort). AGPL-3.0-only. pinned lock Cargo.lock sha256 45e0f6ba...; toolchain
    rustc 1.94.0-nightly a6525d526 2025-12-21, wasm-bindgen 0.2.100, binaryen 125, clang 18.1.8; full recipe and
    registry inventory in vendor/vendor-source-preparation/epoxy-tls-source/. built artifact identity: wasm
    337afcb0..., glue bundle f26cdf17...; generated info version "2.1.18-1" (no npm-release relabeling).

## 3. source offer (route statement, publisher-side placement not done)
scope honesty: this packet is corresponding-source material for the OWNED candidate only. for the old npm runtime it is
lead-level provenance, NOT closed correspondence (binary/source identity unproven). do not read it as covering both.
for the owned candidate the included build inputs are: the epoxy-tls preferred source (93d5a726 archive) + the only
source delta (adaptation patch) + Cargo.lock (45e0f6ba...) + toolchain receipt + registry inventory + git dep archives,
PLUS the transport build inputs (transport-candidate/build-inputs/): the published epoxy-transport 3.0.1 package
(0d65127a..., contains src/main.ts + esbuild.bundle.mjs), the exact copied build inputs (main.ts, esbuild.bundle.mjs,
tsconfig), the package.json with the explicit file: override, the resolved package-lock for the candidate build, and
the owned local package staging (package.json + the pair in owned-pair/). these are the inputs the candidate build
actually consumed; registry-resolved build deps are pinned in the resolved lock.

## 4. open gates (unchanged): independent review of the bundled artifact, actual local Chrome engine run
(Epoxy init + bounded network fixture + browse QA), Main adoption decision. nothing shipped, deployed, or published.
