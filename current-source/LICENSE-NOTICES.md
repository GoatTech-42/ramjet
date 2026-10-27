# License notices for this backend source snapshot

Portions copyright (C) 2026 GoatTech.

This snapshot contains a combined backend and embedded browser assets. It includes legacy Ramjet code distributed under GNU AGPL version 3. The complete backend source in this directory is provided under those applicable AGPL terms; this is not a claim that all included files originated under MIT or that third-party rights have changed.

- `AGPL-3.0.txt` is the license text previously published by Ramjet at commit `2ccadfd26e3551b31ea95c40a63d3d16c54f3676`.
- `backend/crates/ramjetd/assets/sx.js` includes modified legacy Ramjet search-page JavaScript from `core/index.js` as retained in legacy commit `b4836c93855696be0a39243a7f07902683c67161`, including lightbox, data-saver and search-history code. This file is covered by the legacy AGPL license, not the backend workspace's blanket MIT metadata.
- The Rust workspace originally declares MIT and both Rust crates inherit that declaration. `MIT-origin.txt` preserves the project's original MIT permission and copyright notice from commit `3b738c33ff1b8d277ff6aa4a8d1f3d91145bef12`. Those origin permissions and notices are retained; they do not cancel AGPL obligations of the combined distribution.
- Embedded IBM Plex fonts retain their own OFL notice at `backend/crates/ramjetd/assets/fonts/OFL-IBM-Plex-LICENSE.txt`.
- Cargo dependencies are referenced by `Cargo.toml` and `Cargo.lock`, not vendored into this snapshot. Their own terms continue to apply.

Modified source snapshot, 2026-10-26: private workflow comments were removed from Rust and Cargo manifests; one test device display label and one assertion diagnostic were made generic. Runtime source and embedded browser assets are otherwise preserved from the accepted backend source export. The original compiler-input bytes are not asserted to match this cleaned snapshot.

All 165 backend source files, Cargo manifests, lockfile and embedded assets from the bounded snapshot are included under `backend/`. The browser engines and compiled application frontend are not part of this snapshot. No binary release or running deployment is made by this publication. This is a source-preservation branch, not a declaration that every production distribution requirement is complete.

There is no warranty. See the full license terms for copying, modification and redistribution.
