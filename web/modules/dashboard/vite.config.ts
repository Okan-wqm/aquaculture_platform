/// <reference types="vitest" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import federation from '@originjs/vite-plugin-federation';
import { resolve } from 'path';

/**
 * Vite Konfigürasyonu - Dashboard Microfrontend
 *
 * Module Federation ile Shell uygulamasına expose edilir.
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
      // Paylaşılan bağımlılıklar - Host (shell) ile AYNI olmalı
      shared: {
        react: {
          singleton: true,
          requiredVersion: '^18.2.0',
        },
        'react-dom': {
          singleton: true,
          requiredVersion: '^18.2.0',
        },
        'react-router-dom': {
          singleton: true,
          requiredVersion: '^6.21.0',
        },
        // CRITICAL: AuthContext ve TenantContext için zorunlu
        // singleton: true ile host'un provider'larına erişebilir
        '@aquaculture/shared-ui': {
          singleton: true,
          import: true,
        },
        // recharts is used heavily — share to avoid duplication across MF chunks
        recharts: {
          singleton: true,
          requiredVersion: '^2.10.0',
        },
        zustand: {
          singleton: true,
          requiredVersion: '^4.4.0',
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
