import { resolve } from 'path';

import { getSharedConfigWithRecharts } from '@aquaculture/shared-ui/federation/federationSharedConfig';
import { federation } from '@module-federation/vite';
import react from '@vitejs/plugin-react';
import { type PluginOption } from 'vite';
import { defineConfig } from 'vitest/config';
import testPolicy from '@aquaculture/testing/vitest';

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
          // NOTE: `./FarmList` and `./FarmDetail` exposures were removed together
          // with the stub/mock pages they pointed at (FarmListPage, FarmDetailPage)
          // in commit 67c9c472 ("refactor(farm): remove legacy farm concept from
          // frontend"). The shell no longer imports them — all site surfaces go
          // through SetupPage > SitesTab. Re-adding them would break the build
          // because the source files no longer exist.
          // `./SensorDashboard` was removed with its mock-only page
          // (FARM-MEDIUM-114) — live sensor monitoring is owned by the
          // sensor-module remote.
        },
        // FE-HIGH-004: Single source of truth with strictVersion:true.
        // recharts shared (was core): the water-chemistry Deffeyes/secondary
        // charts move to shared-ui, whose recharts import is externalized from
        // dist and must resolve from the federation shared scope.
        shared: getSharedConfigWithRecharts(),
      }),
    ],
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src'),
        '@aquaculture/shared-ui': sharedUiAlias,
        // Water-chemistry presentation components import from shared-ui SOURCE
        // (bundled per-remote, NOT via the federation singleton) so recharts is
        // never forced into the shared-ui singleton. See
        // web/shared-ui/src/water-chemistry/components/index.ts.
        '@platform/shared-ui': resolve(__dirname, '../../shared-ui/src'),
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
      // PERF-HIGH-004: an explicit bundle budget. With every page-level route
      // now React.lazy code-split (Module.tsx), no single async chunk should be
      // large; a chunk over 600 kB (minified, pre-gzip) warns at build time so a
      // regression that re-bundles a heavy page eagerly is caught in CI output.
      chunkSizeWarningLimit: 600,
    },
    test: {
      globals: true,
      environment: 'jsdom',
      setupFiles: ['./src/test-setup.ts'],
      include: ['src/**/*.{test,spec}.{ts,tsx}'],
      ...testPolicy,
      // WHY: React 19 + @testing-library/react 16 + recharts render the heavy
      // water-chemistry Deffeyes charts (multiple toxic-zone layers) in jsdom at
      // ~5.5s — over vitest's 5s default, flaking several chart tests on the
      // boundary. Assertions are correct; the render is just heavy. 20s headroom.
      testTimeout: 20000,
    },
  };
});
