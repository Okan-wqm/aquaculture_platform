import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import federation from '@originjs/vite-plugin-federation';
import { resolve } from 'path';

/**
 * Vite Konfigürasyonu - Farm Module Microfrontend
 */
export default defineConfig({
  plugins: [
    react(),
    federation({
      name: 'farmModule',
      filename: 'remoteEntry.js',
      exposes: {
        './Module': './src/Module.tsx',
        './FarmList': './src/pages/FarmListPage.tsx',
        './FarmDetail': './src/pages/FarmDetailPage.tsx',
        './SensorDashboard': './src/pages/SensorDashboardPage.tsx',
      },
      // Paylaşılan bağımlılıklar — Host (shell) ile EXACT aynı versiyon olmalı.
      //
      // Module Federation negotiation: when both sides declare `singleton: true`,
      // the plugin picks the host's version and expects every remote to declare
      // a compatible `requiredVersion`. If the remote declares a looser range
      // (`^18.2.0`) that does NOT satisfy the host's exact pin (`18.3.1`), the
      // federation runtime falls back to loading the remote's bundled copy —
      // producing TWO React instances at runtime. Two React instances break
      // hooks, context, AND the shared QueryClient, so mutations in the remote
      // land in a different cache than the shell's and invalidation never
      // propagates. This is the "anlık görünmüyor" scenario at the frontend level.
      //
      // Versions here are exact pins matching web/shell/vite.config.ts. If a
      // shell upgrade changes one of these, the remote must be updated in lock
      // step or CI should flag the mismatch before deploy.
      shared: {
        react: { singleton: true, requiredVersion: '18.3.1' },
        'react-dom': { singleton: true, requiredVersion: '18.3.1' },
        'react-router-dom': { singleton: true, requiredVersion: '6.30.3' },
        '@tanstack/react-query': { singleton: true, requiredVersion: '5.90.10' },
        // CRITICAL: AuthContext ve TenantContext için zorunlu
        '@aquaculture/shared-ui': { singleton: true, import: true },
        zustand: { singleton: true, requiredVersion: '4.5.7' },
      },
    }),
  ],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      '@aquaculture/shared-ui': resolve(__dirname, '../../shared-ui/dist'),
      '@aquaculture/farm-shared': resolve(__dirname, '../../../libs/farm-shared/src'),
      // sentinelhub-js peer deps: hoisted to root node_modules but Vite can't
      // resolve them from nested farm-module/node_modules/@sentinel-hub/sentinelhub-js/
      'polygon-clipping': resolve(__dirname, '../../../node_modules/polygon-clipping'),
    },
  },
  server: {
    port: 3002,
    strictPort: true,
    cors: true,
  },
  preview: { port: 3002 },
  base: '/remotes/farm-module/',
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
