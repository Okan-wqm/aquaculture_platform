import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { AQUAMOBIL_SOURCE_ALIAS_AUTHORITY } from './source-alias-authority';

export default defineConfig({
  base: '/mobile/',
  plugins: [
    react(),
    VitePWA({
      // FE-CRITICAL-050-SW: injectManifest makes the HAND-WRITTEN service worker
      // (src/pwa/messaging-sw.ts) the DEPLOYED dist/messaging-sw.js (filename:
      // 'messaging-sw.ts' below), instead of letting VitePWA generate a throwaway
      // SW that dropped every sync / notificationclick / LOGOUT handler. VitePWA
      // compiles the SW through its OWN Vite sub-build and injects the precache
      // manifest into `self.__WB_MANIFEST`.
      strategies: 'injectManifest',
      srcDir: 'src/pwa',
      filename: 'messaging-sw.ts',
      // PERF-10: autoUpdate ensures field workers always run the latest version
      // without needing to manually dismiss an update prompt.
      registerType: 'autoUpdate',
      // Prevent build failure when glob patterns match no files (Docker isolated build)
      mode: 'production',
      includeAssets: ['icons/*.png'],
      manifest: {
        name: 'AquaMobil',
        short_name: 'AquaMobil',
        description: 'Aquaculture Mobile Data Entry - Offline First',
        theme_color: '#0073e6',
        background_color: '#ffffff',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/mobile/',
        scope: '/mobile/',
        icons: [
          {
            src: '/mobile/icons/icon-192x192.png',
            sizes: '192x192',
            type: 'image/png',
          },
          {
            src: '/mobile/icons/icon-512x512.png',
            sizes: '512x512',
            type: 'image/png',
          },
          {
            src: '/mobile/icons/icon-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      selfDestroying: false,
      // FE-CRITICAL-050-SW: injectManifest config. In this mode VitePWA does NOT
      // generate runtime caching or a NavigationRoute — those now live IN the SW
      // (src/pwa/messaging-sw.ts via registerRoute). VitePWA's only job here is to
      // compute the precache manifest from these globs and inject it into the SW's
      // `self.__WB_MANIFEST` placeholder.
      //
      // The app shell (index.html + content-hashed JS/CSS) is precached so the
      // PWA loads offline — the previous generateSW artifact had globPatterns: []
      // and therefore ZERO precache entries, which is exactly what FE-CRITICAL-050
      // flagged. index.html is included so first-paint works offline; the SW's
      // NetworkFirst navigation route still prefers the network when online.
      injectManifest: {
        globDirectory: 'dist',
        globPatterns: ['**/*.{js,css,html,woff2,png,svg}'],
        // disableDevLogs has no effect in injectManifest mode (the SW controls its
        // own logging); kept out intentionally.
      },
      devOptions: {
        enabled: true,
        // FE-CRITICAL-050-SW: an injectManifest SW that uses `import` statements
        // must be served as an ES module in dev, otherwise the browser rejects it
        // with "Cannot use import statement outside a module".
        type: 'module',
      },
    }),
  ],
  resolve: {
    alias: {
      ...AQUAMOBIL_SOURCE_ALIAS_AUTHORITY,
    },
    // Dedupe React across the aliased farm-shared boundary.
    //
    // WHY: aquamobil's Docker build (`Dockerfile.aquamobil`) is a standalone
    //   build context — `npm ci` runs from `web/apps/aquamobil/` so the only
    //   `node_modules/` is at `/monorepo/web/apps/aquamobil/node_modules/`.
    //   `libs/farm-shared` is copied in separately and resolved via the
    //   alias above, NOT installed via npm. When Rollup processes a file
    //   under `/monorepo/libs/farm-shared/src/...` (e.g.
    //   `DynamicMeasurementForm.tsx` which uses JSX → emits a
    //   `react/jsx-runtime` import), Node's bare-specifier resolution walks
    //   up from `/monorepo/libs/farm-shared/` looking for `node_modules`,
    //   finds none under `/monorepo/`, and aborts:
    //     "Rollup failed to resolve import 'react/jsx-runtime' from
    //      libs/farm-shared/src/components/DynamicMeasurementForm.tsx"
    // WHAT: `dedupe` tells Vite to always resolve these bare specifiers to
    //   the consuming project's `node_modules`, regardless of which file is
    //   doing the importing. With this set, `react`, `react-dom`, and the
    //   subpath exports `react/jsx-runtime` + `react/jsx-dev-runtime` all
    //   resolve to `web/apps/aquamobil/node_modules/react/...` — which is
    //   exactly the React copy aquamobil declares as a direct dep.
    //   Architectural Tier-1 ("make it impossible"): no consumer can ever
    //   accidentally pick up a second React via the aliased farm-shared
    //   path again.
    dedupe: ['react', 'react-dom'],
  },
  optimizeDeps: {
    include: ['konsta/react'],
  },
  server: {
    port: 8090,
    strictPort: true,
    host: true,
    proxy: {
      '/graphql': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
  preview: {
    port: 8090,
  },
  build: {
    target: 'esnext',
    // PERF-06: Disable source maps in production to prevent exposing TypeScript
    // source, GraphQL query structures, and internal variable names.
    // Use 'hidden' in CI to upload to error tracking without serving publicly.
    sourcemap: false,
    commonjsOptions: {
      include: [/node_modules/],
      transformMixedEsModules: true,
    },
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ['react', 'react-dom', 'react-router-dom'],
          query: ['@tanstack/react-query'],
        },
      },
      // Force konsta/react resolution
      external: [],
    },
  },
});
