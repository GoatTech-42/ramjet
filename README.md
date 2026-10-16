# Ramjet

Self-hosted web hub with Browse, Jetstream video, Amp music, Sage chat,
Banter messaging and per-account settings. Account data stays in the directory
selected by `RJ_DATA`, outside the source tree.

## Local setup

Use Node.js 20 or newer:

```
npm ci
node scripts/provision-models.mjs
npm run build
RJ_HOST=127.0.0.1 RJ_PORT=14224 RJ_DATA=./data node core/index.js
```

`bin/yt-dlp` is tracked and executable. Video and audio conversion also need
Python 3, ffmpeg and ffprobe on PATH. The Docker image installs those tools.

## Embedding model

The provisioning script fetches MiniLM-L6-v2 ONNX weights and vocabulary from
Xenova/all-MiniLM-L6-v2, pinned to revision
`751bff37182d3f1213fa05d7196b954e230abad9`. The weights are not committed.
Both downloads are verified with SHA256 before use:

- minilm.onnx: `afdb6f1a0e45b715d0bb9b11772f032c399babd23bfc31fed1c170afc848bdb1`
- vocab.txt: `07eced375cec144d27c900241f3e339478dec958f92fddbc551f295c992038a3`

Existing mismatched files are refused rather than silently replaced.
The model repository identifies Apache-2.0 licensing:
https://huggingface.co/Xenova/all-MiniLM-L6-v2
Review its model card and upstream terms before redistribution.

## Docker

```
docker build -t ramjet .
docker run --rm -p 127.0.0.1:14224:14224 -v /absolute/data:/app/data ramjet
```

The build provisions and verifies models in its build stage and copies only
the verified files into the runtime image. No pre-existing local models are
required. Use an absolute data path and keep backups before upgrading.

## Tests and deploys

```
npm ci
node scripts/provision-models.mjs
npm run build
node --test --test-concurrency=1 tests/*.test.mjs
```

Deploys must restart the process. Pages, stamped proxy assets and their
version token are snapshotted together at boot. Rebuilding files underneath
a running process does not update that snapshot.

For browser fixtures, install Playwright and Chrome separately, then use:

```
RJ_PLAYWRIGHT=/path/to/playwright/index.mjs RJ_CHROME=/path/to/chrome node tests/browser/proxied-ws.mjs
RJ_PLAYWRIGHT=/path/to/playwright/index.mjs RJ_CHROME=/path/to/chrome node tests/browser/local-fixture-smoke.mjs
```
