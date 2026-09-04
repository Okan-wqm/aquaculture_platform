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
    // WHY: these are component specs that mount a WHOLE page — router, design
    // system, async client and a full ARIA ledger table — and vitest runs the
    // spec files concurrently, so one test's wall clock includes the CPU every
    // other worker is taking. Measured in isolation a page mount lands near
    // 1.6s; measured with the whole suite in flight the same mount crosses
    // vitest's 5s default and the suite goes red on machine load rather than on
    // a defect. WHAT: the real cost of a page-mount spec is declared here once,
    // with headroom for a loaded machine. This changes no assertion: a query
    // that never resolves still fails the test, it just gets an honest budget
    // instead of one that silently encodes how busy the host was.
    testTimeout: 30_000,
    // Hooks only seed a token and clear storage; they never mount a page, so a
    // hook that runs long is a real hang and keeps a tight budget.
    hookTimeout: 10_000,
  },
});
