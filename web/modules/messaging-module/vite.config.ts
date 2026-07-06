/// <reference types="vitest" />
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { federation } from '@module-federation/vite';
import { resolve } from 'path';
import { getSharedConfigWithLucide } from '../../shared-ui/src/federation/federationSharedConfig';

/**
 * Vite config — Messaging Panel microfrontend.
 *
 * Exposed to the Shell via Module Federation. Shared deps come ONLY from the
 * federationSharedConfig SSoT (FE-HIGH-004: strictVersion singletons so the
 * shell's AuthContext / TenantContext / QueryClient are the ONE instance).
 * socket.io-client is a local dep (independent connections; not a singleton).
 */
export default defineConfig({
  plugins: [
    react(),
    federation({
      dts: false,
      name: 'messagingModule',
      filename: 'remoteEntry.js',
      exposes: {
        './Module': './src/Module.tsx',
      },
      shared: getSharedConfigWithLucide(),
    }),
  ],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      '@aquaculture/shared-ui': resolve(__dirname, '../../shared-ui/dist'),
    },
  },
  base: '/remotes/messaging-module/',
  build: {
    target: 'esnext',
  },
  test: {
    environment: 'jsdom',
    globals: true,
  },
  server: {
    port: 5178,
    strictPort: true,
    cors: true,
  },
});
