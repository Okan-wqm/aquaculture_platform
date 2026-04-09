import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import federation from '@originjs/vite-plugin-federation';
import { resolve } from 'path';
import { getSharedConfigWithReactFlow } from '../shared-ui/src/federation/federationSharedConfig';

/**
 * Vite Konfigürasyonu - Shell (Host) Uygulaması
 *
 * Module Federation ile remote microfrontend'leri tüketir.
 * Paylaşılan bağımlılıkları merkezi olarak yönetir.
 *
 * FE-HIGH-004: Shared deps imported from federationSharedConfig.ts — single
 * source of truth with strictVersion:true enforced on ALL entries.
 */
export default defineConfig(({ command }) => {
  // Development: local docker proxy at localhost:8080/mf/
  // Production build: relative /remotes/ paths resolved by nginx reverse proxy
  const isDev = command === 'serve';
  const remoteBase = isDev ? 'http://localhost:8080/mf' : '/remotes';

  return {
    plugins: [
      react(),
      federation({
        name: 'shell',
        remotes: {
          dashboard: `${remoteBase}/dashboard/assets/remoteEntry.js`,
          farmModule: `${remoteBase}/farm-module/assets/remoteEntry.js`,
          hrModule: `${remoteBase}/hr-module/assets/remoteEntry.js`,
          sensorModule: `${remoteBase}/sensor-module/assets/remoteEntry.js`,
          hydroponicsModule: `${remoteBase}/hydroponics-module/assets/remoteEntry.js`,
          adminPanel: `${remoteBase}/admin-panel/assets/remoteEntry.js`,
          tenantAdmin: `${remoteBase}/tenant-admin/assets/remoteEntry.js`,
        },
        // FE-HIGH-004: Single source of truth — includes reactflow for SCADA
        shared: getSharedConfigWithReactFlow(),
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
      // SH-SEC-14: Restrict CORS to localhost only (not wildcard *).
      // Prevents pages on other origins from reading dev-server responses while
      // a developer is authenticated against the dev backend.
      cors: {
        origin: ['http://localhost:3000', 'http://localhost:8080'],
        credentials: true,
      },
    },
    preview: {
      port: 3000,
    },
    build: {
      target: 'esnext',
    },
  };
});
