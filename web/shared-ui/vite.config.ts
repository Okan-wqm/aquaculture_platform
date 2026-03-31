import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import dts from 'vite-plugin-dts';
import { resolve } from 'path';

/**
 * Vite Konfigürasyonu - Shared UI Library
 *
 * Library mode ile build edilir ve Module Federation üzerinden paylaşılır.
 * Tüm bileşenler, hook'lar ve utility'ler export edilir.
 */
export default defineConfig({
  plugins: [
    react(),
    dts({
      insertTypesEntry: true,
      include: ['src'],
      outDir: 'dist',
    }),
  ],
  build: {
    lib: {
      entry: resolve(__dirname, 'src/index.ts'),
      name: 'AquacultureSharedUI',
      formats: ['es', 'cjs'],
      fileName: (format) => `index.${format === 'es' ? 'mjs' : 'js'}`,
    },
    rollupOptions: {
      // Peer dependencies olarak dışarıda bırak
      // react/jsx-runtime ve react/jsx-dev-runtime da external olmalı,
      // aksi halde automatic JSX runtime bundled olur ve React internals'a erişemez
      external: [
        'react',
        'react-dom',
        'react/jsx-runtime',
        'react/jsx-dev-runtime',
        'react-router-dom',
        '@tanstack/react-query',
      ],
      output: {
        globals: {
          react: 'React',
          'react-dom': 'ReactDOM',
          'react-router-dom': 'ReactRouterDOM',
          '@tanstack/react-query': 'ReactQuery',
        },
        // CSS'i ayrı dosyaya çıkar
        assetFileNames: (assetInfo) => {
          if (assetInfo.name === 'style.css') return 'styles/index.css';
          return assetInfo.name ?? '';
        },
      },
    },
    // SEC-M04: Source maps disabled in production to prevent exposing TypeScript
    // source code, internal variable names, and API structures to attackers.
    // For error tracking (e.g. Sentry), use 'hidden' in CI to upload maps
    // without serving them publicly. Never set to `true` for production builds.
    sourcemap: false,
    // Minify
    minify: 'terser',
    terserOptions: {
      compress: {
        drop_console: true,
        drop_debugger: true,
      },
    },
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
});
