/// <reference types="vitest" />
import { resolve } from 'path';

import createVitestTestPolicy from '@aquaculture/testing/vitest';
import { federation } from '@module-federation/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// WHY: the federation shared-deps SSoT lives in shared-ui SOURCE. This vite
// config is evaluated by Node before shared-ui's runtime barrel (dist) exists,
// so the SSoT must be imported by relative source path — every module's
// vite.config does the same (the nx-boundary is relaxed for vite configs in
// eslint.config.mjs, since a build config cannot go through the npm scope).
import { getSharedConfigWithLucide } from '../../shared-ui/src/federation/federationSharedConfig';
import { resolveSharedUiAlias } from '../../shared-ui/src/federation/sharedUiAlias';

/**
 * Vite config — Messaging Panel microfrontend.
 *
 * Exposed to the Shell via Module Federation. Shared deps come ONLY from the
 * federationSharedConfig SSoT (FE-HIGH-004: strictVersion singletons so the
 * shell's AuthContext / TenantContext / QueryClient are the ONE instance).
 * socket.io-client is a local dep (independent connections; not a singleton).
 */
export default defineConfig(({ mode }) => ({
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
      '@aquaculture/shared-ui': resolveSharedUiAlias(resolve(__dirname, '../../shared-ui'), mode),
    },
  },
  base: '/remotes/messaging-module/',
  build: {
    target: 'esnext',
  },
  test: {
    environment: 'jsdom',
    globals: true,
    ...createVitestTestPolicy(),
  },
  server: {
    port: 5178,
    strictPort: true,
    cors: true,
  },
}));
