import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { federation } from '@module-federation/vite';
import svgr from 'vite-plugin-svgr';
import { resolve } from 'path';
import { getSharedConfigWithReactFlow } from '../../shared-ui/src/federation/federationSharedConfig';

/**
 * Vite Konfigürasyonu - Sensor Module Microfrontend
 *
 * FE-HIGH-004: Shared deps imported from federationSharedConfig.ts — single
 * source of truth with strictVersion:true enforced on ALL entries.
 * Uses getSharedConfigWithReactFlow() for SCADA builder reactflow support.
 */
export default defineConfig(({ mode }) => {
  const sharedUiAlias =
    mode === 'test'
      ? resolve(__dirname, '../../shared-ui/src')
      : resolve(__dirname, '../../shared-ui/dist');

  return {
    plugins: [
      react(),
      svgr({
        // Enable ?react suffix for importing SVGs as React components
        include: '**/*.svg?react',
      }),
      federation({
        dts: false,
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
        // FE-HIGH-004: Single source of truth with strictVersion:true + reactflow
        shared: getSharedConfigWithReactFlow(),
      }),
    ],
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src'),
        '@aquaculture/shared-ui': sharedUiAlias,
        '@platform/shared-ui': resolve(__dirname, '../../shared-ui/src'),
        // Water-chemistry engine (browser-safe, shared SSoT). tsc resolves this via
        // tsconfig.base paths, but Vite needs the explicit alias or dev/build fails.
        '@platform/aquaculture-engines': resolve(
          __dirname,
          '../../../libs/aquaculture-engines/src/index.ts',
        ),
        '@aquaculture/node-components': resolve(
          __dirname,
          '../../../libs/node-components/src/index.ts',
        ),
        '@aquaculture/node-components/edges': resolve(
          __dirname,
          '../../../libs/node-components/src/edges/index.ts',
        ),
        '@platform/sensor-automation-types': resolve(
          __dirname,
          '../../../libs/sensor-automation-types/src/index.ts',
        ),
        // Browser-safe barrel only (types + TagRef grammar + upcasters);
        // the /validators subpath is backend-only and must NOT be aliased here.
        '@platform/sensor-contracts': resolve(
          __dirname,
          '../../../libs/sensor-contracts/src/index.ts',
        ),
      },
      dedupe: ['react', 'react-dom', '@xyflow/react'],
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
  };
});
