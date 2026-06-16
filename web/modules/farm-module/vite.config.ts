import { resolve } from 'path';

import { getCoreSharedConfig } from '@aquaculture/shared-ui/federation/federationSharedConfig';
import { federation } from '@module-federation/vite';
import react from '@vitejs/plugin-react';
import { type PluginOption } from 'vite';
import { defineConfig } from 'vitest/config';

const createReactPlugin = react as () => PluginOption[];

const farmModuleBase = process.env.VITE_FARM_MODULE_BASE ?? '/remotes/farm-module/';

/**
 * Vite Konfigürasyonu - Farm Module Microfrontend
 *
 * FE-HIGH-004: Shared deps imported from federationSharedConfig.ts — single
 * source of truth with strictVersion:true enforced on ALL entries.
 */
export default defineConfig(({ mode }) => {
  const sharedUiAlias =
    mode === 'test'
      ? resolve(__dirname, '../../shared-ui/src')
      : resolve(__dirname, '../../shared-ui/dist');

  return {
    envDir: resolve(__dirname, '../../..'),
    plugins: [
      createReactPlugin(),
      federation({
        dts: false,
        name: 'farmModule',
        filename: 'remoteEntry.js',
        exposes: {
          './Module': './src/Module.tsx',
          // NOTE: `./FarmList`, `./FarmDetail`, and `./SensorDashboard` exposures
          // were removed together with the stub/mock pages they pointed at
          // (FarmListPage, FarmDetailPage — commit 67c9c472; SensorDashboardPage —
          // fe-sensor-fake / FARM-CRITICAL-051, which rendered Math.random() mock
          // telemetry as live water quality). The shell imports none of them — all
          // site surfaces go through SetupPage > SitesTab, and sensor telemetry is
          // owned by sensor-module at /sensor. Re-adding would break the build (the
          // source files no longer exist).
        },
        // FE-HIGH-004: Single source of truth with strictVersion:true
        shared: getCoreSharedConfig(),
      }),
    ],
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src'),
        '@aquaculture/shared-ui': sharedUiAlias,
        '@aquaculture/farm-shared': resolve(__dirname, '../../../libs/farm-shared/src'),
        '@platform/aquaculture-engines': resolve(
          __dirname,
          '../../../libs/aquaculture-engines/src/index.ts',
        ),
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
    base: farmModuleBase,
    build: {
      target: 'esnext',
    },
    test: {
      globals: true,
      environment: 'jsdom',
      setupFiles: ['./src/test-setup.ts'],
      include: ['src/**/*.{test,spec}.{ts,tsx}'],
    },
  };
});
