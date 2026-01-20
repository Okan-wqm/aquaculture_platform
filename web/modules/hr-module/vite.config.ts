import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import federation from '@originjs/vite-plugin-federation';
import { resolve } from 'path';

/**
 * Vite Konfigürasyonu - HR Module Microfrontend
 */
export default defineConfig({
  plugins: [
    react(),
    federation({
      name: 'hrModule',
      filename: 'remoteEntry.js',
      exposes: {
        './Module': './src/Module.tsx',
        './Dashboard': './src/pages/HRDashboardPage.tsx',
        './Employees': './src/pages/EmployeesPage.tsx',
        './Payroll': './src/pages/PayrollPage.tsx',
      },
      shared: {
        react: { singleton: true, requiredVersion: '^18.2.0' },
        'react-dom': { singleton: true, requiredVersion: '^18.2.0' },
        'react-router-dom': { singleton: true, requiredVersion: '^6.21.0' },
        '@tanstack/react-query': { singleton: true, requiredVersion: '^5.17.0' },
        '@aquaculture/shared-ui': { singleton: true, import: false },
        zustand: { singleton: true, requiredVersion: '^4.4.0' },
      },
    }),
  ],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      '@aquaculture/shared-ui': resolve(__dirname, '../../shared-ui/dist'),
      '@shared-ui': resolve(__dirname, '../../shared-ui/src'),
    },
  },
  server: {
    port: 3004,
    strictPort: true,
    cors: true,
  },
  preview: { port: 3004 },
  build: {
    modulePreload: false,
    target: 'esnext',
    minify: false,
    cssCodeSplit: false,
  },
});
