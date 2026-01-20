import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import federation from '@originjs/vite-plugin-federation';
import svgr from 'vite-plugin-svgr';
import { resolve } from 'path';

/**
 * Vite Konfigürasyonu - Sensor Module Microfrontend
 */
export default defineConfig({
  plugins: [
    react(),
    svgr({
      // Enable ?react suffix for importing SVGs as React components
      include: '**/*.svg?react',
    }),
    federation({
      name: 'sensorModule',
      filename: 'remoteEntry.js',
      exposes: {
        './Module': './src/Module.tsx',
        './Dashboard': './src/pages/SensorDashboardPage.tsx',
        './Devices': './src/pages/DevicesPage.tsx',
        './Readings': './src/pages/ReadingsPage.tsx',
        './Alerts': './src/pages/AlertsPage.tsx',
      },
      shared: {
        react: { singleton: true, requiredVersion: '^18.2.0' },
        'react-dom': { singleton: true, requiredVersion: '^18.2.0' },
        'react-router-dom': { singleton: true, requiredVersion: '^6.21.0' },
        '@tanstack/react-query': { singleton: true, requiredVersion: '^5.17.0' },
        '@aquaculture/shared-ui': { singleton: true, import: false },
        zustand: { singleton: true, requiredVersion: '^4.4.0' },
        'use-sync-external-store': { singleton: true },
      },
    }),
  ],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      '@aquaculture/shared-ui': resolve(__dirname, '../../shared-ui/dist'),
    },
    dedupe: ['react', 'react-dom'],
  },
  // Public folder is automatically copied to dist by Vite
  publicDir: 'public',
  server: {
    port: 3005,
    strictPort: true,
    cors: true,
  },
  preview: { port: 3005 },
  build: {
    modulePreload: false,
    target: 'esnext',
    minify: false,
    cssCodeSplit: false,
  },
});
