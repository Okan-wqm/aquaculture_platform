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
        '@tanstack/react-query': {
          singleton: true,
          requiredVersion: '^5.17.0',
        },
        // CRITICAL: AuthContext ve TenantContext için zorunlu
        // singleton: true ile host'un provider'larına erişebilir
        '@aquaculture/shared-ui': {
          singleton: true,
          import: false, // Host'tan al
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
    cors: true,
  },
  preview: {
    port: 3001,
  },
  build: {
    modulePreload: false,
    target: 'esnext',
    minify: false,
    cssCodeSplit: false,
  },
});
