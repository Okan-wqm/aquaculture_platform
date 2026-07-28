/// <reference types="vitest" />
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { federation } from '@module-federation/vite';
import { resolve } from 'path';
import { getSharedConfigWithLucide } from '../../shared-ui/src/federation/federationSharedConfig';
import testPolicy from '@aquaculture/testing/vitest';

/**
 * Vite Konfigürasyonu - Tenant Admin Microfrontend
 *
 * Module Federation ile Shell uygulamasına expose edilir.
 * AuthContext ve TenantContext'e erişim için shared-ui SINGLETON olmalı.
 *
 * FE-HIGH-004: Shared deps imported from federationSharedConfig.ts — single
 * source of truth with strictVersion:true enforced on ALL entries.
 */
export default defineConfig({
  plugins: [
    react(),
    federation({
      dts: false,
      name: 'tenantAdmin',
      filename: 'remoteEntry.js',
      exposes: {
        './Module': './src/Module.tsx',
      },
      // FE-HIGH-004/FE-HIGH-005: shared deps come ONLY from the SSoT.
      // The previous block spread getCoreSharedConfig() and then OVERRODE
      // react-dom / react-router-dom / @tanstack/react-query /
      // @aquaculture/shared-ui with strictVersion-less caret ranges (plus a
      // duplicate lucide-react key whose first entry pinned '^18.2.0') —
      // silently re-enabling the exact double-instance failure mode
      // strictVersion exists to prevent. AuthContext/TenantContext singleton
      // behaviour (shared-ui with import:true) is provided by the core
      // config itself.
      shared: getSharedConfigWithLucide(),
    }),
  ],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      '@aquaculture/shared-ui': resolve(__dirname, '../../shared-ui/dist'),
    },
  },
  base: '/remotes/tenant-admin/',
  build: {
    target: 'esnext',
  },
  // Fix: tenant-admin React tests require jsdom environment for DOM APIs.
  // Without this, Vitest runs in node environment where document/window are undefined.
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    ...testPolicy,
  },
  server: {
    port: 5175,
    strictPort: true,
    cors: true,
  },
  preview: {
    port: 5175,
    strictPort: true,
    cors: true,
  },
});
