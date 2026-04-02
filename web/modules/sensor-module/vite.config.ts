import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import federation from '@originjs/vite-plugin-federation';
import svgr from 'vite-plugin-svgr';
import { resolve } from 'path';

/**
 * Vite Konfigürasyonu - Sensor Module Microfrontend
 */
export default defineConfig({
  plugins: [
    react(),
    svgr({
      // Enable ?react suffix for importing SVGs as React components
      include: '**/*.svg?react',
    }),
    federation({
      name: 'sensorModule',
      filename: 'remoteEntry.js',
      exposes: {
        './Module': './src/Module.tsx',
        './Dashboard': './src/pages/SensorDashboardPage.tsx',
        './Devices': './src/pages/DevicesPage.tsx',
        './Readings': './src/pages/ReadingsPage.tsx',
        './Alerts': './src/pages/AlertsPage.tsx',
        './VfdProgramming': './src/pages/VfdProgrammingPage.tsx',
      },
      shared: {
        react: { singleton: true, requiredVersion: '^18.2.0' },
        'react-dom': { singleton: true, requiredVersion: '^18.2.0' },
        'react-router-dom': { singleton: true, requiredVersion: '^6.21.0' },
        '@tanstack/react-query': { singleton: true, requiredVersion: '^5.17.0' },
        '@aquaculture/shared-ui': { singleton: true, import: true },
        zustand: { singleton: true, requiredVersion: '^4.4.0' },
        /**
         * SCADA-FIX: reactflow MUST be a shared singleton so the federation
         * plugin rewrites its internal `import from 'react'` calls to
         * `importShared('react')`, which resolves to the host's React.
         *
         * Without this, reactflow bundles its own React copy inside the
         * lazy-loaded chunk, causing "Invalid hook call" at runtime.
         *
         * Explicit `version` is REQUIRED because reactflow v11's package.json
         * exports map does not include `"./package.json"`, which the
         * @originjs/vite-plugin-federation resolver needs to auto-detect the
         * version.  Specifying it here bypasses that resolution entirely.
         */
        reactflow: {
          singleton: true,
          requiredVersion: '^11.10.0',
          version: '11.11.4',
        },
      },
    }),
  ],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      '@aquaculture/shared-ui': resolve(__dirname, '../../shared-ui/dist'),
      '@platform/shared-ui': resolve(__dirname, '../../shared-ui/src'),
    },
    dedupe: ['react', 'react-dom', 'reactflow'],
  },
  // Public folder is automatically copied to dist by Vite
  publicDir: 'public',
  server: {
    port: 3005,
    strictPort: true,
    cors: true,
  },
  preview: { port: 3005 },
  base: '/remotes/sensor-module/',
  build: {
    target: 'esnext',
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
  },
});
