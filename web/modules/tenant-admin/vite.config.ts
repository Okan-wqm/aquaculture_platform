import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import federation from '@originjs/vite-plugin-federation';
import { resolve } from 'path';
import { getCoreSharedConfig } from '../../shared-ui/src/federation/federationSharedConfig';

/**
 * Vite Konfigürasyonu - Tenant Admin Microfrontend
 *
 * Module Federation ile Shell uygulamasına expose edilir.
 * AuthContext ve TenantContext'e erişim için shared-ui SINGLETON olmalı.
 *
 * FE-HIGH-004: Shared deps imported from federationSharedConfig.ts — single
 * source of truth with strictVersion:true enforced on ALL entries.
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
      // FE-HIGH-004: Single source of truth with strictVersion:true
      shared: {
        ...getCoreSharedConfig(),
        'lucide-react': {
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
          import: true,
          requiredVersion: '^1.0.0',
        },
        'lucide-react': {
          singleton: true,
          requiredVersion: '^0.469.0',
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
  base: '/remotes/tenant-admin/',
  build: {
    target: 'esnext',
  },
  // Fix: tenant-admin React tests require jsdom environment for DOM APIs.
  // Without this, Vitest runs in node environment where document/window are undefined.
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
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
