/// <reference types="vitest" />
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { federation } from '@module-federation/vite';
import { resolve } from 'path';
import { getSharedConfigWithRecharts } from '../../shared-ui/src/federation/federationSharedConfig';
import { sharedUiAlias } from '../../shared-ui/src/federation/sharedUiAlias';
import { unresolvedAssetUrlGate } from '../../shared-ui/src/federation/unresolvedAssetUrlGate';
import { buildManifestPlugin } from '../../shared-ui/src/federation/buildManifestPlugin';
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
    unresolvedAssetUrlGate(),
    // FE-MEDIUM-380: exports this build's id from remoteEntry.js and serves it in
    // build-manifest.json, so an open console tab reloads onto a new deploy of this remote.
    buildManifestPlugin({ kind: 'remote', entry: 'remoteEntry.js' }),
    federation({
      dts: false,
      name: 'dashboard',
      filename: 'remoteEntry.js',
      // Expose edilen modüller
      // Only the module: the shell mounts its routes (the module dashboards
      // and analytics); the KPI page and its widgets were removed with it.
      exposes: {
        './Module': './src/Module.tsx',
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
      ...sharedUiAlias(resolve(__dirname, '../../shared-ui'), mode),
      // Zero-dependency cross-stack contracts (the many-unit read bound the
      // site rows batch by) — path-aliased, as sensor-module and shared-ui do.
      '@aquaculture/shared-contracts': resolve(__dirname, '../../../libs/shared-contracts/src'),
    },
    // The federation shares these as singletons at runtime; specs resolve
    // shared-ui from source, so they must see the one copy too — a second
    // react-router is a second Router context, and shared-ui's route guards
    // (RequireRole on each dashboard route) could not navigate inside it.
    dedupe: ['react', 'react-dom', 'react-router', 'react-router-dom'],
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
