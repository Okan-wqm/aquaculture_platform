import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import federation from '@originjs/vite-plugin-federation';
import { resolve } from 'path';

/**
 * Vite Konfigürasyonu - Farm Module Microfrontend
 */
export default defineConfig({
  plugins: [
    react(),
    federation({
      name: 'farmModule',
      filename: 'remoteEntry.js',
      exposes: {
        './Module': './src/Module.tsx',
        './FarmList': './src/pages/FarmListPage.tsx',
        './FarmDetail': './src/pages/FarmDetailPage.tsx',
        './SensorDashboard': './src/pages/SensorDashboardPage.tsx',
      },
      // Paylaşılan bağımlılıklar - Host (shell) ile AYNI olmalı
      shared: {
        react: { singleton: true, requiredVersion: '^18.2.0' },
        'react-dom': { singleton: true, requiredVersion: '^18.2.0' },
        'react-router-dom': { singleton: true, requiredVersion: '^6.21.0' },
        '@tanstack/react-query': { singleton: true, requiredVersion: '^5.17.0' },
        // CRITICAL: AuthContext ve TenantContext için zorunlu
        '@aquaculture/shared-ui': { singleton: true, import: false },
        zustand: { singleton: true, requiredVersion: '^4.4.0' },
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
    port: 3002,
    strictPort: true,
    cors: true,
  },
  preview: { port: 3002 },
  build: {
    modulePreload: false,
    target: 'esnext',
    minify: false,
    cssCodeSplit: false,
  },
});
