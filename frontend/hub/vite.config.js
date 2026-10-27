import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import tailwindcss from '@tailwindcss/vite'

// C7.1: version row identity = "v3 · <7-char git sha of the source commit being built>".
// Supplied by the packager as RAMJET_SOURCE_SHA; production builds fail without it
// so the settings version row can never fall back to a dev label.
const sourceSha = (process.env.RAMJET_SOURCE_SHA || '').trim().slice(0, 7)
if (process.env.NODE_ENV === 'production' && !/^[0-9a-f]{7}$/.test(sourceSha))
  throw new Error('RAMJET_SOURCE_SHA (git sha of the source commit being built) is required for production builds')

// stamp row: the same build id goes into the html shell (<meta name="rj-build">) and the
// js bundle (__RAMJET_BUILD__); settings compares the two at runtime. Both are generated here.
const buildDate = new Date().toISOString().slice(0, 10)
const stampMeta = { name: 'rj-build-meta', transformIndexHtml: () => [{ tag: 'meta', attrs: { name: 'rj-build', content: sourceSha }, injectTo: 'head' }] }

export default defineConfig({
  plugins: [tailwindcss(), svelte(), stampMeta],
  define: {
    __RAMJET_RELEASE__: JSON.stringify(`v3 · ${sourceSha}`),
    __RAMJET_BUILD__: JSON.stringify(sourceSha),
    __RAMJET_DATE__: JSON.stringify(buildDate),
    // corresponding-source offer (AGPL s13): production packaging supplies the read-backed
    // published commit url; empty in parity/dev builds hides the settings row
    __RAMJET_SOURCE_URL__: JSON.stringify((process.env.RAMJET_SOURCE_URL || '').trim()),
  },
})
