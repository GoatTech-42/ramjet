# Current Rust source preservation

`backend/` preserves the Rust daemon and shared crypto workspace used for the current accepted backend build. This branch does not replace the legacy default branch or change a running deployment.

This is a bounded backend source snapshot, not a complete migration of the current product. The original project frontend source is not included here, and the compiled frontend and its third-party source/license obligations are still separate work.

Private workflow comments were removed from Rust and Cargo manifests. A test device display label and one test assertion diagnostic were made generic. Those edits have separate snapshot hashes; these public bytes are not the exact original compiler input. Production authentication defaults and ordinary code are retained.

The Cargo workspace's original MIT declaration is retained. This snapshot also contains modified legacy AGPL search-page JavaScript embedded in the backend. The combined source distribution is covered by the applicable AGPL terms, with original MIT and font notices retained. See `LICENSE-NOTICES.md` and the full license texts. This does not relicense the separate legacy project or compiled frontend.

Source build commands:

```
cd backend
cargo build --locked --release
cargo test --locked
```

This publication does not claim that a new release build, runtime adoption or deployment test was performed. Credentials, user data, deployment settings and private project history are not included.
