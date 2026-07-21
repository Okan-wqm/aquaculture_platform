import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { federation } from '@module-federation/vite';
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
        dts: false,
        name: 'shell',
        remotes: {
          dashboard: { type: 'module', name: 'dashboard', entry: `${remoteBase}/dashboard/remoteEntry.js` },
          farmModule: { type: 'module', name: 'farmModule', entry: `${remoteBase}/farm-module/remoteEntry.js` },
          hrModule: { type: 'module', name: 'hrModule', entry: `${remoteBase}/hr-module/remoteEntry.js` },
          sensorModule: { type: 'module', name: 'sensorModule', entry: `${remoteBase}/sensor-module/remoteEntry.js` },
          hydroponicsModule: { type: 'module', name: 'hydroponicsModule', entry: `${remoteBase}/hydroponics-module/remoteEntry.js` },
          messagingModule: { type: 'module', name: 'messagingModule', entry: `${remoteBase}/messaging-module/remoteEntry.js` },
          adminPanel: { type: 'module', name: 'adminPanel', entry: `${remoteBase}/admin-panel/remoteEntry.js` },
          tenantAdmin: { type: 'module', name: 'tenantAdmin', entry: `${remoteBase}/tenant-admin/remoteEntry.js` },
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
      // APA-253: give `npm run dev:web` the SAME /api edge contract as the
      // compose/nginx stacks. The FE http-client base is '/api'; admin-api
      // serves under its globalPrefix '/api/v1'. Proxy /api -> admin-api's
      // published port (3008, per docker-compose admin-api-service) and rewrite
      // ^/api -> /api/v1 so '/api' stays the single FE-side constant in every
      // run mode (no VITE_ADMIN_API_URL hand-wiring).
      proxy: {
        '/api': {
          target: 'http://localhost:3008',
          changeOrigin: true,
          rewrite: (path: string): string => path.replace(/^\/api/, '/api/v1'),
        },
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
