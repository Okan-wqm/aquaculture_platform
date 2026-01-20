import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import federation from '@originjs/vite-plugin-federation';
import { resolve } from 'path';

/**
 * Vite Konfigürasyonu - Tenant Admin Microfrontend
 *
 * Module Federation ile Shell uygulamasına expose edilir.
 * AuthContext ve TenantContext'e erişim için shared-ui SINGLETON olmalı.
 */
export default defineConfig({
  plugins: [
    react(),
    federation({
      name: 'tenantAdmin',
      filename: 'remoteEntry.js',
      exposes: {
        './Module': './src/Module.tsx',
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
        // Bu olmadan useAuthContext() "must be used within AuthProvider" hatası verir
        '@aquaculture/shared-ui': {
          singleton: true,
          import: false, // Host'tan al, kendi kopyasını oluşturma
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
  build: {
    modulePreload: false,
    target: 'esnext',
    minify: false,
    cssCodeSplit: false,
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
