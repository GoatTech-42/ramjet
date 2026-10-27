// emit-pages: C7-ship shape - the SPA shell html, byte-identical at two paths.
// /browse and /jetstream are r32's real app pages again (hub SPA shells cut).
// Every emitted page (root index.html included) is build-stamped; the stitch re-verifies.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { stampIdentity, stampHtml } from './build-stamp.mjs'
const out = process.argv[2] || 'dist'
const src = join(out, 'index.html')
const sha = (b) => createHash('sha256').update(b).digest('hex')
const id = stampIdentity()
const ref = Buffer.from(stampHtml(readFileSync(src), id))
writeFileSync(src, ref) // the root index.html is served too - stamp it as well
for (const name of ['index', 'settings']) {
  const dest = join(out, 'pages', name, `${name}.html`)
  mkdirSync(join(out, 'pages', name), { recursive: true })
  writeFileSync(dest, ref)
  if (sha(readFileSync(dest)) !== sha(ref)) throw new Error(`${dest} not byte-identical`)
  console.log(`emitted ${dest} (sha256 ${sha(ref).slice(0, 12)}... byte-identical, stamped ${id.commit} - ${id.tag})`)
}
