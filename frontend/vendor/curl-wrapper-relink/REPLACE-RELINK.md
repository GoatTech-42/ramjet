# Pinned libcurl transport source and replacement route

This packet adds the wrapper's preferred TypeScript source and build scripts to the separate nested libcurl.js source packet. It is not a claim that a minified npm package is sufficient source.

## Source identity

Wrapper: @mercuryworkshop/libcurl-transport 2.0.5, source snapshot 7daea4a6a87a78f77e003fe4134f8eec749552f0 (2025-12-24) from https://github.com/MercuryWorkshop/libcurl-transport . Its package version is 2.0.5, dependency is libcurl.js ^0.7.4, and its included pnpm-lock.yaml resolves libcurl.js 0.7.4. This is the last upstream commit before the 2026 version/dependency update to 2.0.6. The npm package lacks gitHead metadata, so this is a matching upstream preferred-source snapshot, not an npm build commit attestation. Its plain TypeScript source implements the wrapper API and is included with the build script, lockfile, tsconfig, README and AGPL license. The actual served bundle is byte-identical to the 2.0.5 npm dist/index.mjs, already checked separately.

Nested library: libcurl.js 0.7.4 is LGPL-3.0-or-later. Use its separate supplied source packet at a641cdd857356db6b8ed46c5341cc8f85c4190ba, including client glue, patches, exact client/wisp_client submodule, native source inputs, scripts and original notices.

## Practical modified-library replacement

1. Extract the wrapper source. Retain its lockfile and package identity. Install the locked JS build dependencies using pnpm and the included lockfile. Ordinary install/build scripts must be inspected in the chosen build environment; this packet runs nothing automatically.
2. Build a modified libcurl.js library from its supplied preferred source using its client/build.sh release single_file route. This native build is only needed if the recipient chooses to change the native/library implementation, not merely to distribute the current pinned binary. Preserve the output under a replacement library package with the normal package exports, including `libcurl.js/bundled` -> `libcurl_full.mjs`.
3. Replace the wrapper's resolved libcurl.js package with that local modified package, preserving its exported module interface. A package-manager link/override to the local source-built package is sufficient; do not leave the original library silently bundled. The wrapper's `src/main.ts` directly imports `{ libcurl }` from `libcurl.js/bundled`, and `esbuild.bundle.mjs` bundles that import from the selected package into dist/index.mjs.
4. Run `node esbuild.bundle.mjs` with the supplied wrapper source and selected dependency. Retain its declared JS build dependencies and tsconfig. The ESM output is dist/index.mjs. The upstream script also builds its UMD/type output; no historical output-byte match is required by this recipe. Build failures must be fixed and recorded before claiming a tested replacement route.
5. In the application source build's public assets, replace BOTH `libcurl/index.mjs` and alias `assets/net2/index.mjs` with the rebuilt wrapper output. Keep the same module interface and path or update the application's imports together. Rebuild the application with its own preferred source and dependency lockfile. Do not mix an old compiled application with a changed interface and claim validation.
6. Serve the rebuilt application and test loading, transport initialization, a proxied request, errors, and the user's selectable transport. Keep source and notices accessible with the distribution and maintain any required network source offer. This packet authorizes no production or account change.

Because the transport bundle includes the library inside a single JS module, replacing only a separate WASM URL is not a complete replacement route. The wrapper rebundle step above is the route for a modified bundled library. No proprietary signing key or server-side approval is required for recipients to edit and rebuild these source files; deployment permissions for someone else's server are separate.

## Current pinned binary vs a new build

Providing the actual preferred sources, original license notices, build scripts and corresponding application code sufficient to modify/recombine the library is the intended existing-dependency distribution route. A successful bit-for-bit reproduction of a historical vendor binary is not asserted here. No native build was performed. Final review must determine whether these actual materials and the application's own source/build recipe satisfy the applicable source and replacement requirements.

If a new vendor binary is chosen, pin and retain its actual native source inputs, Emscripten toolchain and certificate input. The historical libcurl.js build script downloads moving curl.se/ca/cacert.pem unless a saved input exists. That is a reason not to claim historical byte reproduction, not an automatic requirement to run a heavy vendor rebuild for the present task.

This packet does not select a new license for Luke's application, settle the complete AGPL application scope, or claim production acceptance.

## Verified dated certificate retrieval

The official index https://curl.se/docs/caextract.html lists dated bundles. Verified example: https://curl.se/ca/cacert-2025-11-04.pem with published checksum at https://curl.se/ca/cacert-2025-11-04.pem.sha256 . The response is an actual PEM certificate bundle, not a guessed URL or merely a successful status. Its observed SHA-256 is 8ac40bdd3d3e151a6b4078d2b2029796e8f843e3f86fbf2adbc4dd9f05e79def. This date predates the package source date, but is NOT claimed to be the historical binary's certificate input. To rebuild with a known input, explicitly choose and preserve a dated bundle at client/build/cacert.pem before the upstream certificate script runs. Mozilla-derived certificate data is MPL-2.0 per the official index. Review and preserve its notices if distributing that data.

For the existing unchanged pinned binary, the unknown historical certificate input remains a reproducibility limitation, not a claim that the preferred source is unavailable. No new vendor build is required by these preparation materials.
