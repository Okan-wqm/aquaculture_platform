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
      external: ['react', 'react-dom', 'react-router-dom', '@tanstack/react-query'],
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
    // Source map oluştur
    sourcemap: true,
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
