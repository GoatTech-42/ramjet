# Ramjet offhost QA lab (generic, sanitized)

These are historical local-fixture render and transition probes, not a production-faithful proxy or a production browsing qualification.

## What is here

- `lab_inside.sh` starts ramjetd, a fixture upstream and a simplified sidecar. Its intended isolation is a fresh user, mount and network namespace with loopback only: `unshare -Urmn bash lab_inside.sh`. Isolation must be established and verified before starting it. The script does not fail closed on every setup error, so invoking it outside that verified namespace is not safe.
- `sidecar.js` implements the HTTP bridge frame shape: a JSON request and binary replies with a u32be request id and u8 type (0 metadata, 1 body, 2 end, 3 error). It is not the production sidecar. It ignores request bodies, adblock selection and cancellation, uses ordinary `fetch`, and when `fetch` decompresses a response body it retains the content-encoding header. It must not be used as an external-egress substitute or to qualify those behaviors.
- `fixture_srv.js` and `fixture/` provide controlled local upstream pages, marker strings and subresources.
- `harness.js` checks desktop/mobile login, service-worker identity and fixture navigation.
- `harness5.js` exercises per-file atomic-rename cutover transitions with service-worker/CDP instrumentation and SHA readbacks.
- `harness4.js` and `harness6.js` attempt service-worker restart probes through CDP with shorter and longer waits around the vendored five-second guard window. Stop errors are caught, so these attempts alone do not prove that a worker stopped or that either window was covered.

## Prerequisites and limits

Use a fresh fixture account only. Never copy live authentication data. These probes assume fixture-specific signup/configuration and do not establish the production sync-admin configuration.

The probes require separately supplied backend/static artifacts, Node dependencies and system Chrome. No complete reproducible dependency/artifact closure is supplied here. `LAB_ROOT`, `FIXTURE_DIR`, `DIST` and `MODE` parameterize only parts of the setup; absolute `/tmp/fullapp` paths remain in the sidecar, harnesses and sync probes. Inspect and adapt all paths before reuse.

A probe's success label is not proof of rendered content, current production protocol fidelity, WARP-only egress, gameplay or cold-boot timing. Inspect actual content/pixels and bind each result to the exact artifacts and configuration used. Preserve old results as historical observations rather than upgrading them to current qualification.
