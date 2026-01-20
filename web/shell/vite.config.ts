import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import federation from '@originjs/vite-plugin-federation';
import { resolve } from 'path';

/**
 * Vite Konfigürasyonu - Shell (Host) Uygulaması
 *
 * Module Federation ile remote microfrontend'leri tüketir.
 * Paylaşılan bağımlılıkları merkezi olarak yönetir.
 */
export default defineConfig({
  plugins: [
    react(),
    federation({
      name: 'shell',
      // Remote microfrontend'ler
      // Docker'da nginx proxy üzerinden, development'ta doğrudan
      remotes: {
        // Dashboard module
        dashboard: 'http://localhost:8080/mf/dashboard/assets/remoteEntry.js',
        // Farm module
        farmModule: 'http://localhost:8080/mf/farm-module/assets/remoteEntry.js',
        // HR module
        hrModule: 'http://localhost:8080/mf/hr-module/assets/remoteEntry.js',
        // Sensor module (includes Process Editor)
        sensorModule: 'http://localhost:8080/mf/sensor-module/assets/remoteEntry.js',
        // Admin Panel module (SUPER_ADMIN)
        adminPanel: 'http://localhost:8080/mf/admin-panel/assets/remoteEntry.js',
        // Tenant Admin module (TENANT_ADMIN)
        tenantAdmin: 'http://localhost:8080/mf/tenant-admin/assets/remoteEntry.js',
      },
      // Paylaşılan modüller - SINGLETON olarak işaretlenmeli
      // Bu sayede tüm remote modüller aynı instance'ı kullanır
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
        // CRITICAL: shared-ui MUST be singleton for context sharing
        // Bu olmadan her modül kendi AuthContext kopyasını alır ve context chain kırılır
        '@aquaculture/shared-ui': {
          singleton: true,
          import: true,  // Shell shared-ui'yi bundle'lar, remote'lar bu singleton'ı kullanır
        },
        zustand: {
          singleton: true,
          requiredVersion: '^4.4.0',
        },
        // ReactFlow için gerekli - React instance paylaşımı
        'use-sync-external-store': {
          singleton: true,
        },
      },
    }),
  ],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      '@aquaculture/shared-ui': resolve(__dirname, '../shared-ui/dist'),
    },
  },
  server: {
    port: 3000,
    strictPort: true,
    cors: true,
  },
  preview: {
    port: 3000,
  },
  build: {
    modulePreload: false,
    target: 'esnext',
    minify: false,
    cssCodeSplit: false,
  },
});
