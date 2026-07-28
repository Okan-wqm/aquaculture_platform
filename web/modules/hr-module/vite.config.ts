import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { federation } from '@module-federation/vite';
import { resolve } from 'path';
import { getCoreSharedConfig } from '../../shared-ui/src/federation/federationSharedConfig';
import testPolicy from '@aquaculture/testing/vitest';

/**
 * Vite Konfigürasyonu - HR Module Microfrontend
 *
 * FE-HIGH-004: Shared deps imported from federationSharedConfig.ts — single
 * source of truth with strictVersion:true enforced on ALL entries.
 */
export default defineConfig({
  plugins: [
    react(),
    federation({
      dts: false,
      name: 'hrModule',
      filename: 'remoteEntry.js',
      exposes: {
        './Module': './src/Module.tsx',
        './Dashboard': './src/pages/HRDashboardPage.tsx',
        './Payroll': './src/pages/PayrollPage.tsx',
      },
      // FE-HIGH-004: Single source of truth with strictVersion:true
      shared: getCoreSharedConfig(),
    }),
  ],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      '@aquaculture/shared-ui': resolve(__dirname, '../../shared-ui/dist'),
      '@shared-ui': resolve(__dirname, '../../shared-ui/src'),
    },
  },
  server: {
    port: 3006,
    strictPort: true,
    cors: true,
  },
  preview: { port: 3006 },
  base: '/remotes/hr-module/',
  build: {
    target: 'esnext',
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    ...testPolicy,
  },
});
