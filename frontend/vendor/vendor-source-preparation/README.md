# Ramjet vendor source preparation

Preparation materials only. Not a complete frontend source distribution, a byte-reproduced build, or permission to deploy.

## Source and patches

- `scramjet-c26bfc6-source.tar.gz`: exact upstream git archive at `c26bfc6d7f7c7f4dac52ce182a2ceab90e851823`, tag `v2.0.67-alpha.2`. Core package version 2.0.67-alpha.2 and controller 0.0.14 declare AGPL-3.0-only. Source: https://github.com/MercuryWorkshop/scramjet/tree/v2.0.67-alpha.2
- `patches/01-history-null-argument.patch`: reconstructed preferred TypeScript form of the one modified Scramjet history handler. A null or undefined third argument calls the original history method, dispatches navigation, and returns before URL coercion. This is reconstructed source, not a recovered original patch or byte-build proof.
- `patches/02-controller-paths.patch`: reconstructed controller source changes for the five alias path values, six string token occurrences in the runtime output.
- `mercuryworkshop-epoxy-transport-3.0.1.tgz`: actual npm package, including its TypeScript source and build script. Source: https://github.com/MercuryWorkshop/epoxy-transport ; tarball: https://registry.npmjs.org/@mercuryworkshop/epoxy-transport/-/epoxy-transport-3.0.1.tgz
- `patches/03-epoxy-output-alias.patch`: output-only packaging rename `epoxy.wasm` to `net.wasm`. The preferred TypeScript transport source is unchanged. This is intentionally an output packaging patch, not falsely described as a preferred-source change.

## Build recipe and limits

Extract the Scramjet source, apply patches 01 and 02 with `git apply`, and use its pinned workspace/lockfile. Upstream requires Node, pnpm, Rust nightly with wasm32 support, wasm-bindgen-cli 0.2.105, Binaryen wasm-opt, and the r58playz wasm-snip fork. Run `pnpm install --frozen-lockfile`, then from `packages/core` run `RELEASE=1 pnpm rewriter:build` and `pnpm build`. The build uses the repository's rspack configuration. Inspect upstream build scripts before choosing an execution environment. No heavy build was performed for this preparation packet.

Extract the Epoxy package separately. Its `src/main.ts` is the preferred transport source, with `@mercuryworkshop/epoxy-tls` pinned to 2.1.19-1. Its own package build is `node esbuild.bundle.mjs` after installing its declared dependencies. Apply patch 03 to the resulting `dist/index.mjs` as a packaging alias step, and arrange the matching WASM asset under the alias path. No lockfile or byte-reproducibility is claimed for that upstream package build.

The runtime alias files were identified from actual package bytes/tokens: codec WASM equals Scramjet WASM; player worker/inject equal controller tokens; controller API differs by the path aliases; net differs by the one WASM filename token; net2 equals libcurl transport 2.0.5. The exact libcurl package and its own corresponding source dependencies still need inclusion/availability qualification for a final distribution. These materials do not by themselves close every nested dependency source obligation.

Run `node scripts/history-guard-test.cjs` for six isolated reconstructed-handler vectors. These test null, undefined, empty, relative, same-origin and cross-origin inputs. They are not a test of a rebuilt library or the application.

## Notices

Modified source preparation dated 2026-10-26. Preserve upstream copyright, licenses and any additional notices. The pinned packages declare AGPL-3.0-only; the license text is in `licenses/AGPL-3.0.txt`. This packet does not change the license of Luke's own application. Direct browser integration with these libraries needs the combined-work/source scope qualified before public distribution. The preferred source of the current application remains a separate issue, not solved by this vendor packet.
