/// <reference types="vitest" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import federation from '@originjs/vite-plugin-federation';
import { resolve } from 'path';
import { getCoreSharedConfig } from '../../shared-ui/src/federation/federationSharedConfig';

/**
 * Vite Konfigürasyonu - Dashboard Microfrontend
 *
 * Module Federation ile Shell uygulamasına expose edilir.
 *
 * FE-HIGH-004: Shared deps imported from federationSharedConfig.ts — single
 * source of truth with strictVersion:true enforced on ALL entries.
 */
export default defineConfig({
  plugins: [
    react(),
    federation({
      name: 'dashboard',
      filename: 'remoteEntry.js',
      // Expose edilen modüller
      exposes: {
        './Module': './src/Module.tsx',
        './DashboardPage': './src/pages/DashboardPage.tsx',
        './OverviewWidgets': './src/components/OverviewWidgets.tsx',
      },
      // FE-HIGH-004: Single source of truth with strictVersion:true
      shared: {
        ...getCoreSharedConfig(),
        // recharts is used heavily — share to avoid duplication across MF chunks
        recharts: {
          singleton: true,
          strictVersion: true,
          requiredVersion: '^2.10.0',
        },
      },
    }),
  ],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      '@aquaculture/shared-ui': resolve(__dirname, '../../shared-ui/dist'),
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
  },
});
