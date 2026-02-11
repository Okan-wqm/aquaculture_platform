import { defineConfig, Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { resolve } from 'path';

// Custom plugin to resolve 'konsta' to 'konsta/react'
function konstaResolve(): Plugin {
  return {
    name: 'konsta-resolve',
    enforce: 'pre',
    resolveId(id) {
      if (id === 'konsta') {
        return { id: 'konsta/react', external: false };
      }
      return null;
    },
  };
}

export default defineConfig({
  plugins: [
    konstaResolve(),
    react(),
    VitePWA({
      registerType: 'prompt',
      includeAssets: ['favicon.ico', 'icons/*.png'],
      manifest: {
        name: 'AquaMobil',
        short_name: 'AquaMobil',
        description: 'Aquaculture Mobile Data Entry - Offline First',
        theme_color: '#0073e6',
        background_color: '#ffffff',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/',
        scope: '/',
        icons: [
          {
            src: '/icons/icon-192x192.svg',
            sizes: '192x192',
            type: 'image/svg+xml',
          },
          {
            src: '/icons/icon-512x512.svg',
            sizes: '512x512',
            type: 'image/svg+xml',
          },
          {
            src: '/icons/icon-512x512.svg',
            sizes: '512x512',
            type: 'image/svg+xml',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
        runtimeCaching: [
          {
            // GraphQL API - Network first with fallback
            urlPattern: /\/graphql/,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'api-cache',
              expiration: {
                maxEntries: 50,
                maxAgeSeconds: 60 * 60 * 24, // 24 hours
              },
              networkTimeoutSeconds: 10,
              cacheableResponse: {
                statuses: [0, 200],
              },
            },
          },
          {
            // Static assets - Cache first
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
            urlPattern: /\.(?:png|jpg|jpeg|svg|gif|webp)$/,
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
      'konsta': 'konsta/react',
    },
  },
  optimizeDeps: {
    include: ['konsta/react'],
    exclude: ['konsta'],
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
    sourcemap: true,
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
