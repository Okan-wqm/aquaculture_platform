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
           * MF-SINGLETON: ReactFlow's duplicate-React crash is solved by
           * ensuring react + react-dom are shared singletons (above).
           * The remote's reactflow singleton declaration is sufficient --
           * the host does NOT need to list reactflow/use-sync-external-store
           * because Vite's exports resolver fails when the package is not
           * installed in the host (Missing "./package.json" specifier).
           */
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
