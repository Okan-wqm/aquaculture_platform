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
           * MF-SINGLETON: react/jsx-runtime must be shared so the JSX transform
           * inside every remote resolves to the host React instance, preventing
           * duplicate-React "null useRef" crashes.
           */
          'react/jsx-runtime': {
            singleton: true,
            requiredVersion: '^18.2.0',
          },
          /**
           * MF-SINGLETON: reactflow and use-sync-external-store are consumed
           * only by sensor-module, but the host MUST list them as shared
           * singletons so that @originjs/vite-plugin-federation can negotiate
           * the singleton contract at runtime. Without the host-side entry,
           * the remote bundles its own copy which pulls a separate React
           * instance -- causing "Cannot read properties of null (reading
           * 'useRef')" in ReactFlow hooks.
           *
           * import: false prevents the host from actually bundling these
           * libraries; it only participates in the shared-scope handshake.
           */
          reactflow: {
            singleton: true,
            requiredVersion: '^11.10.0',
            import: false,
          },
          'use-sync-external-store': {
            singleton: true,
            import: false,
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
