/// <reference types="vitest" />
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { federation } from '@module-federation/vite';
import { resolve } from 'path';
import { getCoreSharedConfig } from '../../shared-ui/src/federation/federationSharedConfig';
import createVitestTestPolicy from '@aquaculture/testing/vitest';

/**
 * Vite Konfigürasyonu - Admin Panel Microfrontend
 *
 * FE-HIGH-004: Shared deps imported from federationSharedConfig.ts — single
 * source of truth with strictVersion:true enforced on ALL entries.
 */
export default defineConfig({
  plugins: [
    react(),
    federation({
      dts: false,
      name: 'adminPanel',
      filename: 'remoteEntry.js',
      exposes: {
        './Module': './src/Module.tsx',
        './UserManagement': './src/pages/UserManagementPage.tsx',
        './TenantManagement': './src/pages/TenantManagementPage.tsx',
        './SystemSettings': './src/pages/SystemSettingsPage.tsx',
      },
      // FE-HIGH-004: Single source of truth with strictVersion:true
      shared: getCoreSharedConfig(),
    }),
  ],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      '@aquaculture/shared-ui': resolve(__dirname, '../../shared-ui/dist'),
      '@aquaculture/shared-contracts': resolve(
        __dirname,
        '../../../libs/shared-contracts/src/index.ts',
      ),
      '@platform/shared-ui': resolve(__dirname, '../../shared-ui/src'),
      '@platform/admin-http-contracts': resolve(
        __dirname,
        '../../../platform/libs/admin-http-contracts/src/index.ts',
      ),
      '@platform/identity': resolve(__dirname, '../../../libs/event-contracts/src/roles.ts'),
      '@platform/tenant-settings': resolve(
        __dirname,
        '../../../libs/event-contracts/src/tenant-settings.ts',
      ),
      '@platform/tenant-permissions': resolve(
        __dirname,
        '../../../libs/event-contracts/src/tenant-permissions.ts',
      ),
      '@platform/pagination-contracts': resolve(
        __dirname,
        '../../../platform/libs/pagination-contracts/src/index.ts',
      ),
      '@platform/reporting-contracts': resolve(
        __dirname,
        '../../../platform/libs/reporting-contracts/src/index.ts',
      ),
      '@platform/tenant-vocabulary': resolve(
        __dirname,
        '../../../libs/event-contracts/src/tenant-vocabulary.ts',
      ),
      '@platform/pricing-metric-vocabulary': resolve(
        __dirname,
        '../../../libs/event-contracts/src/billing/pricing-metric-vocabulary.ts',
      ),
    },
  },
  server: { port: 3004, strictPort: true, cors: true },
  preview: { port: 3004 },
  base: '/remotes/admin-panel/',
  build: { target: 'esnext' },
  // 2026-05-06: React hook/component tests require DOM APIs. Keep this as a
  // project-level runtime contract instead of per-spec environment pragmas.
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test-setup.ts'],
    ...createVitestTestPolicy(),
  },
});
