// build stamp: every served page bootstrap carries the build identity as
// <!-- ramjet v3 - <commit> - <imageTag> -->. Identity comes from the real build
// environment: RAMJET_COMMIT (fallback: git rev-parse --short HEAD) and
// RAMJET_IMAGE_TAG (env only - an image tag cannot be derived). Missing identity
// is a hard fail, and so is a missing or stale stamp on a staged page.
import { execSync } from 'node:child_process'

const STAMP_RE = /<!-- ramjet v3 - ([^ ]+) - ([^ ]+) -->/

export function stampIdentity() {
  let commit = (process.env.RAMJET_COMMIT || '').trim()
  if (!commit) { try { commit = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() } catch {} }
  const tag = (process.env.RAMJET_IMAGE_TAG || '').trim()
  if (!commit) throw new Error('build stamp: no commit identity - set RAMJET_COMMIT (or run inside a git checkout)')
  if (!tag) throw new Error('build stamp: no image tag - set RAMJET_IMAGE_TAG')
  return { commit, tag, line: `<!-- ramjet v3 - ${commit} - ${tag} -->` }
}

// inject (or refresh) the stamp right after the doctype
export function stampHtml(buf, id) {
  const t = buf.toString().replace(/\n?<!-- ramjet v3 - [^\n]*-->/, '')
  return t.replace(/(<!doctype html>\n?)/i, `$1${id.line}\n`)
}

// staged-page gate: missing or stale stamp fails the stitch loudly
export function verifyStamped(file, buf, id) {
  const m = buf.toString().match(STAMP_RE)
  if (!m) throw new Error(`build stamp: missing on ${file}`)
  if (m[1] !== id.commit || m[2] !== id.tag) throw new Error(`build stamp: stale on ${file} (${m[1]} - ${m[2]} != ${id.commit} - ${id.tag})`)
}
