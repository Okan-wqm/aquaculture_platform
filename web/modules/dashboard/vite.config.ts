/// <reference types="vitest" />
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { federation } from '@module-federation/vite';
import { resolve } from 'path';
import { getSharedConfigWithRecharts } from '../../shared-ui/src/federation/federationSharedConfig';
import { resolveSharedUiAlias } from '../../shared-ui/src/federation/sharedUiAlias';
import createVitestTestPolicy from '@aquaculture/testing/vitest';

/**
 * Vite Konfigürasyonu - Dashboard Microfrontend
 *
 * Module Federation ile Shell uygulamasına expose edilir.
 *
 * FE-HIGH-004: Shared deps imported from federationSharedConfig.ts — single
 * source of truth with strictVersion:true enforced on ALL entries.
 */
export default defineConfig(({ mode }) => ({
  plugins: [
    react(),
    federation({
      dts: false,
      name: 'dashboard',
      filename: 'remoteEntry.js',
      // Expose edilen modüller
      exposes: {
        './Module': './src/Module.tsx',
        './DashboardPage': './src/pages/DashboardPage.tsx',
        './OverviewWidgets': './src/components/OverviewWidgets.tsx',
      },
      // FE-HIGH-004/FE-HIGH-005: single source of truth — recharts moved
      // into federationSharedConfig so no shared-entry literal lives here
      // (the federation invariant bans inline entries in vite configs).
      shared: getSharedConfigWithRecharts(),
    }),
  ],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      '@aquaculture/shared-ui': resolveSharedUiAlias(resolve(__dirname, '../../shared-ui'), mode),
    },
  },
  server: {
    port: 3001,
    strictPort: true,
    // Restrict CORS to known development origins (DASH-SEC-008)
    cors: {
      origin: ['http://localhost:8080', 'http://localhost:3000', 'http://localhost:3001'],
    },
  },
  preview: {
    port: 3001,
  },
  base: '/remotes/dashboard/',
  build: {
    target: 'esnext',
    // Ensure minification is enabled (default esbuild) — CRIT-1 / DASH-SEC-012
    minify: 'esbuild',
    // Enable CSS code splitting for route-level deferral — PERF-M5
    cssCodeSplit: true,
  },
  // BUG-L5: vitest configuration for @testing-library/react
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test-setup.ts'],
    css: false,
    ...createVitestTestPolicy(),
  },
}));
