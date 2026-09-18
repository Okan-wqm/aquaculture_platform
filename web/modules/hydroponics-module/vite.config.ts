import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { federation } from '@module-federation/vite';
import { resolve } from 'path';
import { getCoreSharedConfig } from '../../shared-ui/src/federation/federationSharedConfig';
import { resolveSharedUiAlias } from '../../shared-ui/src/federation/sharedUiAlias';
import createVitestTestPolicy from '@aquaculture/testing/vitest';

/**
 * Vite Configuration - Hydroponics Module Microfrontend
 *
 * FE-HIGH-004: Shared deps imported from federationSharedConfig.ts — single
 * source of truth with strictVersion:true enforced on ALL entries.
 */
export default defineConfig(({ mode }) => ({
  plugins: [
    react(),
    federation({
      dts: false,
      name: 'hydroponicsModule',
      filename: 'remoteEntry.js',
      exposes: {
        './Module': './src/Module.tsx',
      },
      // FE-HIGH-004: Single source of truth with strictVersion:true
      shared: getCoreSharedConfig(),
    }),
  ],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      '@aquaculture/shared-ui': resolveSharedUiAlias(resolve(__dirname, '../../shared-ui'), mode),
      '@shared-ui': resolve(__dirname, '../../shared-ui/src'),
    },
  },
  server: {
    port: 3008,
    strictPort: true,
    cors: true,
  },
  preview: { port: 3008 },
  base: '/remotes/hydroponics-module/',
  build: {
    target: 'esnext',
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test-setup.ts'],
    ...createVitestTestPolicy(),
  },
}));
