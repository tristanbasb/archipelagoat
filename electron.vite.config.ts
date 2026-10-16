import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'

const fromRoot = (path: string): string => fileURLToPath(new URL(path, import.meta.url))

const shared = fromRoot('./src/shared')

export default defineConfig({
  // Main: dependencies stay external (build.externalizeDeps defaults to true).
  main: {
    resolve: { alias: { '@shared': shared, '@main': fromRoot('./src/main') } },
  },
  // A sandboxed preload can only `require('electron')`: bundle everything into one CJS file.
  // Vite 8 renamed rollupOptions to rolldownOptions; electron-vite 6 reads only the latter.
  preload: {
    resolve: { alias: { '@shared': shared } },
    build: {
      externalizeDeps: false,
      rolldownOptions: { output: { format: 'cjs', entryFileNames: 'index.js' } },
    },
  },
  renderer: {
    resolve: { alias: { '@shared': shared, '@renderer': fromRoot('./src/renderer/src') } },
    plugins: [react()],
    build: {
      // The CSP has `font-src 'self'`: small font files must stay files, never data: URIs.
      assetsInlineLimit: (file) => (/\.(woff2?|ttf|otf)$/.test(file) ? false : undefined),
    },
  },
})
