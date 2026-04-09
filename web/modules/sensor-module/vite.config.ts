import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import federation from '@originjs/vite-plugin-federation';
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
      // FE-HIGH-004: Single source of truth with strictVersion:true + reactflow
      shared: getSharedConfigWithReactFlow(),
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
