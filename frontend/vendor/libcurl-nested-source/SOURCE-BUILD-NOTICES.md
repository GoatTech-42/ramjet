# libcurl.js 0.7.4 nested source preparation

This packet supplies actual preferred source and build scripts for the pinned nested library, not merely an npm compiled package. It is preparation for review, not a claim that the whole application distribution or relink obligations have been met.

## Provenance

The retained application lockfile pins libcurl.js 0.7.4. The served libcurl transport bundle identifies `libcurl.js@0.7.4` and reports library version 0.7.4. The npm registry's 0.7.4 metadata identifies source git commit `a641cdd857356db6b8ed46c5341cc8f85c4190ba` and LGPL-3.0-or-later. Exact source archive, including C glue, JavaScript API, output patches and build scripts, is included.

Source: https://github.com/ading2210/libcurl.js
Npm metadata: https://registry.npmjs.org/libcurl.js/0.7.4
Pinned package: https://registry.npmjs.org/libcurl.js/-/libcurl.js-0.7.4.tgz

The exact client/wisp_client submodule is commit 455b9186bfbd0915ed7082c9d356af2157ab014f from https://github.com/MercuryWorkshop/wisp-client-js . Its source and original license are included. The server/wisp_server submodule is not used by this client-library build and is not included.

## Native source inputs

The actual client build scripts select the following sources. All are included as git source archives with original license texts, resolved commits and checksums in the packet manifest:

- ading2210/curl branch 8.17.0-patched, commit a15072369578a37ce314ea4d8b06f30c2762ebcc. This is a patched curl source fork, not stock curl; the curl permission notice is preserved.
- google/brotli v1.2.0, commit 028fb5a23661f123017c060daa546b55cf4bde29, MIT.
- DaveGamble/cJSON v1.7.19, commit c859b25da02955fef659d658b8f324b5cde87be3, MIT.
- Mbed-TLS/mbedtls mbedtls-3.6.5, commit e185d7fd85499c8ce5ca2a54f5cf8fe7dbe3f8df, dual Apache-2.0 OR GPL-2.0-or-later as its original license states. Original full terms retained, not silently replaced by a different license.
- Mbed-TLS/mbedtls-framework submodule 457996474728cb8e968ed21953b72f74d2f536b2, included at the exact submodule pin.
- nghttp2/nghttp2 v1.68.0, commit 534b74b72524e962c18c7146470914632ca7eb2d, MIT.
- madler/zlib v1.3.1, commit 51b7f2abdade71cd9bb0e7a373ef2610ec6f9daf, zlib license.

These are the refs named by the library source's build scripts, resolved and archived now. No historical binary build log establishes which checkout a prebuilt npm binary used. The curl branch head is dated 2025-12-01 and agrees with the package source date, but that is not byte-rebuild evidence.

## Build and replacement route

On Linux, extract libcurl.js source and place the wisp-client archive under client/wisp_client. Native dependency archives can be used to populate the source checkout directories expected by client/tools/*.sh, retaining their exact pins; inspect those scripts rather than fetching a newer branch by accident. Restore the Mbed TLS framework submodule at framework/.

Upstream build requires Python 3, make, CMake, Emscripten, autoconf, automake, libtool, pkg-config, wget, xxd and jq. Its README identifies tested Emscripten versions 3.1.6 and 3.1.72. From client/, `./build.sh release single_file` builds the bundled JavaScript module used by the transport, while `./build.sh release` produces separate JS/WASM outputs. `./build.sh all` produces both. Build scripts, fragments, exported function lists and patches are included in the source archive.

The build's certificate-generation script downloads https://curl.se/ca/cacert.pem when no saved build/cacert.pem exists. That moving certificate input is not historically pinned in the package source. A byte-reproducible match to the existing npm binary is not claimed. For a new source-built replacement, pin and preserve the chosen certificate input along with the new output.

No native build or live replacement was performed here. A final distribution must provide actual library source/notices, and for a combined LGPL work preserve the ability and instructions to replace/relink the library with modified versions using the corresponding application code. The transport's own preferred source/build wrapper and the application's AGPL combined-work scope remain separate gates. This packet does not authorize a new license choice for the application and does not claim that npm metadata alone discharges the license.
