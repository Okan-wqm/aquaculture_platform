import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import federation from '@originjs/vite-plugin-federation';
import { resolve } from 'path';
import { getCoreSharedConfig } from '../../shared-ui/src/federation/federationSharedConfig';

/**
 * Vite Konfigürasyonu - Farm Module Microfrontend
 *
 * FE-HIGH-004: Shared deps imported from federationSharedConfig.ts — single
 * source of truth with strictVersion:true enforced on ALL entries.
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
      // FE-HIGH-004: Single source of truth with strictVersion:true
      shared: getCoreSharedConfig(),
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
