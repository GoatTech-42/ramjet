// serve-stub: static server for a built dist + /api/lite/* stub for smoke-404.
// Usage: node scripts/serve-stub.mjs <dist-dir> <port> <ok|fail>
// ok:   /search answers a 4-result ok:true envelope; other routes answer minimal ok.
// fail: every /api/lite/* answers 404 {"ok":false,"error":"not found"}.
import { createServer } from 'node:http'
import { readFileSync, existsSync, statSync } from 'node:fs'
import { join, extname } from 'node:path'

const [dir, port, mode] = process.argv.slice(2)
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2', '.wasm': 'application/wasm' }
const RESULTS = [
  { id: 'xT3slaR0d51', title: 'the new tesla roadster: my honest reaction', channel: 'mkbhd', duration: '22:45', views: '8.9m' },
  { id: 'hV0mi3wApP2', title: 'apple homeview impressions: not convinced', channel: 'the verge', duration: '11:47', views: '9.8m' },
  { id: 'gB00kWtf913', title: 'wtf is a googlebook?', channel: 'ltt', duration: '14:13', views: '8.3m' },
  { id: 'w1spRu57xQ4', title: 'writing a wisp transport in rust', channel: 'low level dave', duration: '31:02', views: '412k' },
]
const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)) }
createServer((req, res) => {
  const u = new URL(req.url, 'http://x')
  if (u.pathname.startsWith('/api/lite')) {
    if (mode === 'fail') return json(res, 404, { ok: false, error: 'not found' })
    if (u.pathname === '/api/lite/search') return json(res, 200, { ok: true, q: u.searchParams.get('q'), page: 1, per_page: 8, has_more: false, next_page: null, results: RESULTS.map((v, i) => ({ ...v, label: `${i + 1}. ${v.title}`, line: `${v.title}||${v.id}`, thumb: `/api/lite/media?kind=image&id=${v.id}`, video: `/api/lite/video?id=${v.id}` })), lines: RESULTS.map((v) => v.title) })
    if (u.pathname === '/api/lite/health') return json(res, 200, { ok: true, service: 'ramjet-lite', time: new Date().toISOString() })
    return json(res, 200, { ok: true })
  }
  // ramjetd static prefix gate (r32 allowlist): anything outside these prefixes 404s
  const GATED = ['/assets/', '/skin/', '/a/', '/favicon.svg', '/favicon-32.png', '/apple-touch-icon.png', '/icon-192.png', '/logo-512.png', '/manifest.webmanifest']
  const PRETTY = { '/': 'index.html', '/browse': 'pages/browse/browse.html', '/jetstream': 'pages/jetstream/jetstream.html', '/settings': 'pages/settings/settings.html' }
  if (PRETTY[u.pathname]) {
    const p = join(dir, PRETTY[u.pathname])
    res.writeHead(200, { 'content-type': 'text/html' })
    return res.end(readFileSync(p))
  }
  if (!GATED.some((g) => u.pathname.startsWith(g))) {
    res.writeHead(404, { 'content-type': 'application/json' })
    return res.end('{"ok":false,"error":"not found"}')
  }
  const p = join(dir, u.pathname)
  if (!existsSync(p) || !statSync(p).isFile()) {
    res.writeHead(404, { 'content-type': 'application/json' })
    return res.end('{"ok":false,"error":"not found"}')
  }
  res.writeHead(200, { 'content-type': MIME[extname(p)] || 'application/octet-stream' })
  res.end(readFileSync(p))
}).listen(port, () => console.log(`stub:${mode} on :${port} serving ${dir}`))
