import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { resolve } from 'node:path';

const pages = ['index', 'login', 'password', 'claim', 'jetstream', 'browse', 'amp', 'sage', 'banter', 'settings'];
export default defineConfig({
  root: 'src',
  plugins: [svelte()],
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    rollupOptions: {
      external: ["/epoxy/index.mjs"],
      input: Object.fromEntries(pages.map((p) => [p, resolve('src/pages', p, `${p}.html`)])),
      output: {
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
});
