import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { resolve } from 'path';

export default defineConfig({
  base: '/mobile/',
  plugins: [
    react(),
    VitePWA({
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
      workbox: {
        // Disable precaching entirely -- all assets use runtimeCaching.
        // This prevents vite-plugin-pwa from failing when glob patterns match no files in Docker builds.
        globPatterns: [],

        // FIX(SW-001): Disable the auto-generated NavigationRoute that binds to
        // createHandlerBoundToURL("index.html"). vite-plugin-pwa auto-generates this
        // when registerType is 'autoUpdate', but createHandlerBoundToURL requires the
        // URL to exist in the precache manifest. Since globPatterns is [], index.html
        // is NOT precached, causing:
        //   "Uncaught (in promise) non-precached-url :: [{"url":"index.html"}]"
        // Using navigateFallbackDenylist with a catch-all regex prevents the NavigationRoute
        // from matching any request. SPA navigation is handled by the NetworkFirst
        // runtimeCaching rule below instead.
        navigateFallbackDenylist: [/./],

        // FIX(SW-002): skipWaiting + clientsClaim ensure the new service worker activates
        // immediately on deployment, replacing the old SW without waiting for all tabs to close.
        // Without this, users can be stuck on stale cached assets until they close ALL tabs.
        skipWaiting: true,
        clientsClaim: true,

        // Suppress workbox development logs in production
        disableDevLogs: true,

        runtimeCaching: [
          // CRIT-2 / SEC-02 / PERF-01: GraphQL runtime caching has been intentionally
          // removed. Reasons:
          // 1. Caching authenticated GraphQL POST responses leaks tenant data between
          //    users on shared devices (Cache Storage is not cleared on logout).
          // 2. Workbox cannot distinguish mutations from queries — cached mutation
          //    responses cause offline queue operations to be silently discarded.
          // 3. POST requests are keyed by URL only, so only one response is stored
          //    per URL, providing no real offline query value.
          // Offline reads use the application-layer IndexedDB cache (cacheData/getCachedData).
          {
            // FIX(SW-003): SPA navigation fallback via NetworkFirst strategy.
            // For navigation requests (HTML pages), always try network first so deployments
            // are picked up immediately. Falls back to cache for offline support.
            // This replaces the broken precache-bound NavigationRoute.
            urlPattern: ({ request }) => request.mode === 'navigate',
            handler: 'NetworkFirst',
            options: {
              cacheName: 'navigation-cache',
              networkTimeoutSeconds: 5,
              expiration: {
                maxEntries: 1,
                maxAgeSeconds: 60 * 60 * 24, // 1 day
              },
            },
          },
          {
            // Static assets - Cache first (content-hashed filenames make this safe)
            urlPattern: /\.(?:js|css|woff2?)$/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'static-cache',
              expiration: {
                maxEntries: 100,
                maxAgeSeconds: 60 * 60 * 24 * 7, // 7 days
              },
            },
          },
          {
            // Images - Stale while revalidate
            urlPattern: /\.(?:png|jpg|jpeg|gif|webp)$/,
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'image-cache',
              expiration: {
                maxEntries: 100,
                maxAgeSeconds: 60 * 60 * 24 * 30, // 30 days
              },
            },
          },
        ],
      },
      devOptions: {
        enabled: true,
      },
    }),
  ],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
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
