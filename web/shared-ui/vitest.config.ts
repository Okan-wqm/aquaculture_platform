import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';
import testPolicy from '@aquaculture/testing/vitest';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      // Promoted water-chemistry compute/charts import the engine; resolve it to
      // source for shared-ui's own vitest (mirrors the vite.config build alias).
      '@platform/aquaculture-engines': resolve(
        __dirname,
        '../../libs/aquaculture-engines/src/index.ts',
      ),
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
    include: ['src/**/*.{spec,test}.{ts,tsx}'],
    ...testPolicy,
    coverage: {
      ...testPolicy.coverage,
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.spec.*', 'src/**/*.test.*', 'src/test-setup.ts'],
    },
  },
});
