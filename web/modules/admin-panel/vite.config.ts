import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import federation from '@originjs/vite-plugin-federation';
import { resolve } from 'path';

export default defineConfig({
  plugins: [
    react(),
    federation({
      name: 'adminPanel',
      filename: 'remoteEntry.js',
      exposes: {
        './Module': './src/Module.tsx',
        './UserManagement': './src/pages/UserManagementPage.tsx',
        './TenantManagement': './src/pages/TenantManagementPage.tsx',
        './SystemSettings': './src/pages/SystemSettingsPage.tsx',
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
  server: { port: 3004, strictPort: true, cors: true },
  preview: { port: 3004 },
  build: { modulePreload: false, target: 'esnext', minify: false, cssCodeSplit: false },
});
