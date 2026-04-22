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
        // NOTE: `./FarmList` and `./FarmDetail` exposures were removed together
        // with the stub/mock pages they pointed at (FarmListPage, FarmDetailPage)
        // in commit 67c9c472 ("refactor(farm): remove legacy farm concept from
        // frontend"). The shell no longer imports them — all site surfaces go
        // through SetupPage > SitesTab. Re-adding them would break the build
        // because the source files no longer exist.
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
    // FE-MEDIUM-037: Scope CORS to the shell origin instead of reflecting
    // Access-Control-Allow-Origin: * which would allow any origin to load
    // remote module assets in dev mode.
    cors: {
      origin: 'http://localhost:3000',
    },
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
