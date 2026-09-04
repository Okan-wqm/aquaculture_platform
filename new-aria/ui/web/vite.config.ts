// Vite + Vitest configuration for the operator console SPA.
//
// WHY: the SPA is built from `ui/` (npm scripts pass `--config web/vite.config.ts`),
// so every path here is anchored to THIS file rather than to the process cwd —
// otherwise `root`/`outDir` would silently depend on where the operator ran npm.
// WHAT: root = web/, output = web/dist, dev proxy forwards /api to the Node
// projection server so the browser never needs CORS, and the vitest block runs
// the component tests in jsdom without injected globals (explicit imports only).
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

const webRoot = decodeURIComponent(new URL('.', import.meta.url).pathname);

export default defineConfig({
  root: webRoot,
  base: '/',
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    target: 'es2022',
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8480',
        changeOrigin: false,
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: false,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    css: false,
  },
});
