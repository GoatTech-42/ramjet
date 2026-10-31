# epoxy-tls 2.1.20-1 repair bundle: NOTICE entry + provenance supplement (candidate, uncommitted)

status: published source-offer documentation. not an adoption statement, not a
dist change, not a deploy, not a claim of legal sufficiency. supersedes the
parked 2.1.19-1 documentation, whose artifact is upstream-deprecated on the
eMudhra trust base and must not be newly shipped.
scope: the repair bundle replacing the deprecated net transport wasm (2.1.19-1 /
4e26f08f, reachable on the default ws connect path) with the upstream-supported
artifact (2.1.20-1), preserving the deployed bundle shape.

## section 1 - NOTICE entry candidate (for the frontend tree)

    epoxy-tls (net transport wasm)
    upstream: MercuryWorkshop/epoxy-tls, https://github.com/MercuryWorkshop/epoxy-tls
    license: GNU Affero General Public License v3.0 (AGPL-3.0-only)
    the full license text is distributed alongside this notice.
    deployed artifact: @mercuryworkshop/epoxy-tls 2.1.20-1, full/epoxy.wasm,
    sha256 de1487e3e10b002583598bbbb1cda3cb257ed407339bcc7578be6a04638a984f
    corresponding source: commit 9cde724aea1a0f5e46b1c962b3d19ca1389af074
    (in-bytes build declaration + codeload archive binding; see provenance
    supplement for what that does and does not establish).

## section 2 - provenance supplement (evidence chain, verified byte-for-byte 2026-10-31)

each step was re-run against live sources or the actual bytes, not
transcribed from any build receipt.

1. registry record. npm view @mercuryworkshop/epoxy-tls@2.1.20-1 returns:
   dist.integrity  sha512-4xRxm8KGcLdHpVrTC2SG0+7khJFH6J6z6XlUsBJSb6Prj3ejVtsVbiWmGkZQcza+F9JZIKmL+i3KC9hHryZ01Q==
   dist.shasum  253273610c70e98587bca89ebdd8cc4babc8423b
   gitHead  ABSENT (unlike 2.1.19-1) - no registry commit binding exists
   license  AGPL-3.0-only, no deprecation on this version.
2. tarball bytes. the tarball's sha512 is
   e314719bc28670b747a55ad30b6486d3eee4849147e89eb3e97954b012526fa3eb8f77a356db156e25a61a46507336be17d25920a98bfa2dca0bd847af2674d5,
   byte-for-byte equal to the registry integrity value; two independently
   fetched copies (the packet's attachment and a fresh registry download) are
   identical. tarball sha256 a5c215ddb07a3123a04d5fe3df8a9f54d20a0e306200714c710fee10c00616b5.
3. wasm artifact. full/epoxy.wasm is 1,251,857 B, sha256
   de1487e3e10b002583598bbbb1cda3cb257ed407339bcc7578be6a04638a984f.
   minimal/epoxy.wasm differs (c04cb8e1...); the bundle embeds the full build.
4. candidate bundle. index.mjs sha256
   0e80cef54868b83fa9daccd9438757ec48bc07f62b61cd49d5160f69ad6c5dee (1,717,548 B):
   - exactly one embedded base64 blob; independently decoded and hashed: exactly
     the 2.1.20-1 full wasm of step 3.
   - in-bytes info record: { version: "2.1.20-1", minimal: false, release: true,
     commit: "9cde724aea1a0f5e46b1c962b3d19ca1389af074" }.
   - zero occurrences of "2.1.19-1"; the deprecated 4e26f08f bytes are absent.
   - exactly one new URL("epoxy.wasm", import.meta.url) - the deployed stitch
     alias shape is preserved unchanged.
   - node import smoke check: module loads, default export callable.
     NOT a runtime qualification - no browser, no TLS data path tested.
5. source binding. epoxy-tls-9cde724a-source.tar.gz sha256
   599746a5f0d04c94ca2d40a0555c5dcc68235fbac7b7c09526388a06d454d2fc; a fresh
   independent codeload fetch of the same commit produces byte-identical output.
   because the registry gitHead is absent, the commit binding rests on
   (a) the in-bytes info record of step 4 and (b) this archive of the declared
   commit. the archive's own version metadata is committed consistently
   (client/Cargo.toml 2.1.20, client/package.json 2.1.20-1) - the 2.1.19-1
   publish-time version-bump wrinkle does not recur, though uncommitted
   working-tree differences at build time are still not excluded.
6. trust-base fix mechanism. Cargo.lock at 9cde724a pins rustls-webpki 0.103.16
   and webpki-roots 1.0.10 (held 93d5a726 lock: 0.103.4 / 1.0.2); both git
   dependencies are unchanged (h2-wasm 2852a7c94b92..., hyper-util-wasm
   07117dd90174...). the trust-fix basis is the upstream publisher's
   account at commit 9cde724a together with the pinned rustls-webpki 0.103.16
   and webpki-roots 1.0.10. eMudhra chain rejection is NOT verified by benign
   runtime QA: a benign init/connect pass cannot prove rejection of a hostile
   certificate chain, and the negative-chain coverage bound remains unverified.
7. strings qualification. eMudhra/emSign anchor strings remain present in the
   2.1.20-1 wasm bytes (9 hits). string presence neither confirms nor refutes
   the distrust, which operates at the trust-decision level, not by removing
   anchor bytes.

what this establishes: a publisher-record plus in-bytes binding from the exact
embedded wasm to the integrity-verified npm artifact and the declared upstream
commit whose archive we hold, under AGPL-3.0-only with license text present.

what this does not establish: a byte build proof (nobody rebuilt from 9cde724a
and compared outputs); behavioral confirmation of the eMudhra distrust (crate-
behavior trust plus pending runtime QA); legal sufficiency of the compliance
posture (not decidable from metadata, not decided here).

remaining limits: real-browser default-path runtime qualification of the
bundle is a separate check from this documentation (benign init/connect only,
no credentials, no sensitive traffic), and any deployment decision follows it.
the deprecated old binary and all builds from the pre-fix source remain
unsuitable for new shipping on the compromised trust base.
