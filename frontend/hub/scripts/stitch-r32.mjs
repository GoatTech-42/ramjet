// stitch-r32: assemble the full ramjet dist = C7 v31 shell + r32 engine statics
// and the non-C7 app pages (login, password, claim, banter, sage, amp, browse, jetstream).
// Usage: node scripts/stitch-r32.mjs <r32-dist> <c7-dist> <staged-out> <manifest-out>
// Deterministic: byte-preserving copies only; hard-fails on asset name collisions
// or dangling references to replaced r32 shell assets.
import { cpSync, copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, relative } from 'node:path'
import { stampIdentity, stampHtml, verifyStamped } from './build-stamp.mjs'

const [r32, c7, staged, manifestOut] = process.argv.slice(2)
if (!r32 || !c7 || !staged || !manifestOut) throw new Error('usage: stitch-r32.mjs <r32-dist> <c7-dist> <staged-out> <manifest-out>')

// r32 shell entries replaced by the C7 shell (referenced only by r32's own replaced pages)
const REPLACED = new Set([
  'index-CJ6ihqB0.js', 'index-CPSZptdb.css',
  'settings-DXZAUtYL.js', 'settings-BZB4Pi2L.css',
])
// [r32 dist dir(s), served dir, {file renames}]: served paths carry no engine vocabulary. A rebuilt r32 dist
// ships skin/; an older one still has cloak/ - either maps to /skin/.
const ENGINE = [
  [['scramjet'], 'assets/codec', { 'scramjet.js': 'codec.js', 'scramjet.wasm': 'codec.wasm' }],
  [['epoxy'], 'assets/net', {}],
  [['libcurl'], 'assets/net2', {}],
  [['skin', 'cloak'], 'skin', {}],
  [['controller'], 'assets/player', { 'controller.api.js': 'api.js', 'controller.sw.js': 'worker.js', 'controller.inject.js': 'inject.js' }],
]
// [r32 dist file, served path]
const RENAMED_ROOT = [['browse-sw.js', 'a/player-boot.js']]
// exact-string cross-reference rewrites inside copied engine files: [served file, from, to, expected count].
// A count mismatch hard-fails the stitch, so an engine bump cannot silently ship a stale path.
const REWRITES = [
  ['assets/player/api.js', 'prefix:"/~/sj/"', 'prefix:"/a/r/"', 1],
  ['assets/player/api.js', 'scramjetPath:"/scramjet/scramjet.js"', 'scramjetPath:"/assets/codec/codec.js"', 1],
  ['assets/player/api.js', 'injectPath:"/controller/controller.inject.js"', 'injectPath:"/assets/player/inject.js"', 1],
  ['assets/player/api.js', 'wasmPath:"/scramjet/scramjet.wasm"', 'wasmPath:"/assets/codec/codec.wasm"', 1],
  ['assets/player/api.js', 'virtualWasmPath:"scramjet.wasm.js"', 'virtualWasmPath:"codec.wasm.js"', 1],
  ['assets/player/api.js', 'maskedfiles:["inject.js","scramjet.wasm.js"]', 'maskedfiles:["inject.js","codec.wasm.js"]', 1],
  ['assets/net/index.mjs', 'new URL("epoxy.wasm", import.meta.url)', 'new URL("net.wasm", import.meta.url)', 1],
  ['a/player-boot.js', 'importScripts("/controller/controller.sw.js")', 'importScripts("/assets/player/worker.js")', 1],
]
const SOURCEMAP_RE = /\n?\/\/# sourceMappingURL=[^\n]*/g // no sourcemap references in served engine files
const ROOT_STATICS = ['favicon.svg', 'favicon-32.png', 'apple-touch-icon.png', 'icon-192.png', 'logo-512.png', 'manifest.webmanifest']
const KEPT_PAGES = ['login', 'password', 'claim', 'banter', 'sage', 'amp', 'browse', 'jetstream']

rmSync(staged, { recursive: true, force: true })
cpSync(c7, staged, { recursive: true }) // C7 shell: index.html, assets, fonts, pages/{index,settings}

for (const [srcs, dest, renames] of ENGINE) {
  const from = srcs.find((d) => { try { return statSync(join(r32, d)).isDirectory() } catch { return false } })
  if (!from) throw new Error(`engine dir missing in r32 dist: ${srcs.join('|')}`)
  mkdirSync(join(staged, dest), { recursive: true })
  for (const f of readdirSync(join(r32, from))) cpSync(join(r32, from, f), join(staged, dest, renames[f] || f), { recursive: true })
  for (const f of Object.keys(renames)) statSync(join(r32, from, f)) // a missing renamed file fails loudly
}
for (const [f, dest] of RENAMED_ROOT) { mkdirSync(join(staged, dest, '..'), { recursive: true }); copyFileSync(join(r32, f), join(staged, dest)) }
for (const [file, from, to, want] of REWRITES) {
  const fp = join(staged, file)
  const text = readFileSync(fp, 'utf8')
  const n = text.split(from).length - 1
  if (n !== want) throw new Error(`engine rewrite: expected ${want} of ${from} in ${file}, found ${n}`)
  writeFileSync(fp, text.split(from).join(to))
}
for (const f of ['assets/codec/codec.js', 'assets/player/api.js', 'assets/player/worker.js', 'assets/player/inject.js']) {
  const fp = join(staged, f)
  writeFileSync(fp, readFileSync(fp, 'utf8').replace(SOURCEMAP_RE, ''))
}
for (const f of ROOT_STATICS) copyFileSync(join(r32, f), join(staged, f))
mkdirSync(join(staged, 'assets'), { recursive: true })
// referenced-asset closure: only assets reachable from kept pages ship. r32's own
// replaced shell pages (index/settings/flick) leave no assets in the staged tree,
// regardless of what a fresh r32 build hashed them to.
const REF_RE = /(?:\/assets\/|["'(]\.\/)([A-Za-z0-9_.-]+\.(?:js|css|woff2?|png|svg|webp|jpg|mp3|webm|mp4))/g
const r32Assets = new Set(readdirSync(join(r32, 'assets')))
const referenced = new Set()
const queue = []
for (const p of KEPT_PAGES) {
  const html = readFileSync(join(r32, 'pages', p, `${p}.html`), 'utf8')
  for (const m of html.matchAll(REF_RE)) if (r32Assets.has(m[1])) { referenced.add(m[1]); queue.push(m[1]) }
}
while (queue.length) {
  const f = queue.pop()
  if (!/\.(js|css)$/.test(f)) continue
  const t = readFileSync(join(r32, 'assets', f), 'utf8')
  for (const m of t.matchAll(REF_RE)) if (r32Assets.has(m[1]) && !referenced.has(m[1])) { referenced.add(m[1]); queue.push(m[1]) }
}
for (const f of readdirSync(join(r32, 'assets'))) {
  if (REPLACED.has(f)) continue
  if (!referenced.has(f)) continue // unreferenced by kept pages: belongs to a replaced r32 page
  const dest = join(staged, 'assets', f)
  try { // same basename must mean same bytes
    if (readFileSync(dest).compare(readFileSync(join(r32, 'assets', f))) !== 0) throw new Error(`asset collision with different bytes: ${f}`)
  } catch (e) { if (e.code !== 'ENOENT') throw e }
  copyFileSync(join(r32, 'assets', f), dest)
}
for (const p of KEPT_PAGES) cpSync(join(r32, 'pages', p), join(staged, 'pages', p), { recursive: true })

// no kept file may reference a replaced r32 asset
function* walk(dir) { for (const e of readdirSync(dir)) { const p = join(dir, e); if (statSync(p).isDirectory()) yield* walk(p); else yield p } }
for (const f of walk(staged)) {
  if (!/\.(js|html|css|webmanifest)$/.test(f)) continue
  const t = readFileSync(f, 'utf8')
  for (const r of REPLACED) if (t.includes(r)) throw new Error(`dangling reference to replaced ${r} in ${f}`)
}

// build stamp: r32 kept pages are stamped here; then the root entry and every
// staged page bootstrap must carry the current identity - missing or stale fails.
const stampId = stampIdentity()
for (const p of KEPT_PAGES) {
  const f = join(staged, 'pages', p, `${p}.html`)
  writeFileSync(f, stampHtml(readFileSync(f), stampId))
}
verifyStamped(join(staged, 'index.html'), readFileSync(join(staged, 'index.html')), stampId)
for (const f of walk(join(staged, 'pages'))) if (f.endsWith('.html')) verifyStamped(f, readFileSync(f), stampId)

// manifest over the whole staged tree
const sha = (b) => createHash('sha256').update(b).digest('hex')
const lines = [...walk(staged)].map((f) => `${sha(readFileSync(f))}  ./${relative(staged, f)}`).sort()
const body = lines.join('\n') + '\n'
writeFileSync(manifestOut, body)
console.log(`staged ${lines.length} files; manifest sha256 ${sha(body)}`)
