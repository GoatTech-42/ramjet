# ramjet frontend - publication notes

this directory is the corresponding source for the ramjet frontend, published
under the GNU Affero General Public License v3 (see LICENSE). it is published
additively alongside the backend source on this branch; the backend content
and its own notices are unchanged. nothing here promotes anything to the
default branch.

## layout

    LICENSE                          GNU AGPL v3
    NOTICE                           component license summary
    THIRD-PARTY-NOTICES.txt          full copyright + permission texts for the
                                     bundled javascript libraries (svelte,
                                     bits-ui, tailwindcss, @tailwindcss/vite),
                                     copied from the installed package files
    licenses/OFL-IBM-Plex-LICENSE.txt  IBM Plex font license (SIL OFL-1.1)
    RECIPE.md                        build + stitch recipe
    hub/                             hub shell source (home + settings)
    r32/                             app pages source (login, password, claim,
                                     banter, sage, amp, browse, jetstream)
    vendor/                          preferred sources, patches and licenses for
                                     the vendored proxy engine components:
      vendor-source-preparation/       scramjet v2.0.67-alpha.2 (AGPL-3.0-only)
                                       + two reconstructed patches; epoxy
                                       transport 3.0.1 (AGPL-3.0-only)
      libcurl-nested-source/           libcurl.js 0.7.4 (LGPL-3.0-or-later)
                                       preferred source + native inputs
      curl-wrapper-relink/             libcurl-transport 2.0.5 (AGPL-3.0-only)
                                       wrapper source + build route

## building

see RECIPE.md. two source trees, one staged output: vite builds r32 (pages +
engine statics), vite builds hub, then hub/scripts/stitch-r32.mjs assembles the
deployed tree with served-path renames and a sha256 manifest. engine statics
have a single input each: staged assets/net2/index.mjs is the same file as
r32/src/public/libcurl/index.mjs, carried through the build and renamed by the
stitch - there is no second, separately served copy.

the build stamps every page with its source commit identity and fails without
it. production builds additionally set RAMJET_SOURCE_URL to the published
commit url; this drives the corresponding-source offer below.

## corresponding-source offer (AGPL section 13)

the running app links to this source from settings > advanced > source code.
the link target is injected at build time from the actual published commit -
the build does not carry a hardcoded or placeholder url. builds without the
url (development, parity checks) omit the row entirely.

## notes on the vendor packets

the vendor directories are preparation packets with their own READMEs. two
things in them read as stale against the published recipe and should be read
with these corrections:

- any note that nested libcurl.js source qualification is still open: it is
  closed; the libcurl-nested-source and curl-wrapper-relink packets are the
  qualification, and they ship here.
- the wrapper relink's instruction to replace both libcurl/index.mjs and
  assets/net2/index.mjs: superseded by the single-input route above. one
  input file, renamed once by the stitch.

license facts a reader should not have to re-derive:

- the vendored engine components are AGPL-3.0(-only) upstream (scramjet,
  epoxy transport, libcurl-transport, ultraviolet-lineage), except libcurl.js
  0.7.4 and wisp-js, which are LGPL-3.0-or-later; native inputs of libcurl.js
  keep their own licenses (curl permission notice, brotli/cJSON/nghttp2 MIT,
  mbedtls Apache-2.0 OR GPL-2.0-or-later, zlib). see NOTICE and each packet's
  licenses/ directory.
- backend-side heritage, noticed with the backend source: sx.js derives
  from the legacy core index and is noticed as legacy AGPL; the Rust
  workspace is the MIT-origin part, noticed separately. no MIT-origin
  mapping exists for the frontend code; THIRD-PARTY-NOTICES.txt is
  dependency attribution only.
- the vendor preparation packet carries an hls.js Apache-2.0 license text,
  but no hls.js usage was found in the shipped frontend. it is included with
  the packet for completeness, not as a shipped-component claim.
- the IBM Plex webfonts are Copyright (c) 2017 IBM Corp., Reserved Font Name
  "Plex", under SIL OFL-1.1 (licenses/OFL-IBM-Plex-LICENSE.txt).
