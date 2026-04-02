import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import federation from '@originjs/vite-plugin-federation';
import { resolve } from 'path';

/**
 * Vite Konfigürasyonu - Shell (Host) Uygulaması
 *
 * Module Federation ile remote microfrontend'leri tüketir.
 * Paylaşılan bağımlılıkları merkezi olarak yönetir.
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
          '@aquaculture/shared-ui': {
            singleton: true,
            requiredVersion: '^1.0.0',
          },
          zustand: {
            singleton: true,
            requiredVersion: '^4.4.0',
          },
          /**
           * SCADA-FIX: reactflow MUST be shared by the host so the remote
           * can find it in globalThis.__federation_shared__ and both sides
           * use the same React instance.
           *
           * Explicit `version` is REQUIRED because reactflow v11's
           * package.json exports map omits "./package.json", which
           * @originjs/vite-plugin-federation uses to auto-detect the
           * version.  Providing `version` here bypasses that resolution
           * and prevents the "Missing ./package.json specifier" build
           * error permanently.
           */
          reactflow: {
            singleton: true,
            requiredVersion: '^11.10.0',
            version: '11.11.4',
          },
        },
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
