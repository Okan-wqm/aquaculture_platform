import { resolve } from 'path';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * Standalone build for the process-editor P&ID canvas iframe (SENSOR-MEDIUM-004).
 *
 * Bundles React 19 + @xyflow/react + recharts + @aquaculture/node-components from
 * node_modules — NO CDN, no jsx-runtime shim, no hand-managed global <script> graph.
 * Emits into public/ with a RELATIVE base so the same artifact resolves under both
 * the dev server root (/process-editor-canvas.html) and the prod remote base
 * (/remotes/sensor-module/process-editor-canvas.html) — the main MF build then
 * copies public/ into dist/. Runs before `vite build` AND `vite` (dev) so the
 * served canvas can never be a stale hand-copied file.
 */
export default defineConfig({
  root: __dirname,
  plugins: [react()],
  base: './',
  publicDir: false,
  build: {
    target: 'esnext',
    outDir: 'public',
    emptyOutDir: false,
    rollupOptions: {
      input: resolve(__dirname, 'process-editor-canvas.html'),
    },
  },
});
