import { resolve } from 'path';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';


/**
 * Vite Configuration for @aquaculture/node-components
 *
 * Builds:
 * - ES Module (dist/index.mjs) - for Vite-bundled apps
 * - CommonJS (dist/index.cjs) - for Node.js/Jest
 * - UMD (dist/aquaculture-nodes.umd.js) - for HTML canvases using CDN React/ReactFlow
 */
export default defineConfig({
  plugins: [
    react(),
    dts({
      insertTypesEntry: true,
      include: ['src'],
      outDir: 'dist/types',
    }),
  ],
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
  build: {
    lib: {
      entry: resolve(__dirname, 'src/index.ts'),
      name: 'AquacultureNodes',
      formats: ['es', 'cjs', 'umd'],
      fileName: (format) => {
        if (format === 'umd') return 'aquaculture-nodes.umd.js';
        return `index.${format === 'es' ? 'mjs' : 'cjs'}`;
      },
    },
    rollupOptions: {
      // External dependencies - not bundled
      external: ['react', 'react-dom', '@xyflow/react'],
      output: {
        globals: {
          react: 'React',
          'react-dom': 'ReactDOM',
          // xyflow v12 UMD still exposes the global `ReactFlow` (verified in
          // node_modules/@xyflow/react/dist/umd/index.js), so the CDN canvases'
          // `window.ReactFlow` usage is unchanged by the reactflow->xyflow bump.
          '@xyflow/react': 'ReactFlow',
        },
        // Ensure proper exports in UMD
        exports: 'named',
      },
    },
    sourcemap: true,
    // Output to dist folder
    outDir: 'dist',
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
});
