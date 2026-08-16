import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';
import createVitestTestPolicy from '@aquaculture/testing/vitest';

// Bound once: this config is the only policy consumer that also EXTENDS the
// policy's coverage block (with shared-ui's own include/exclude), so it needs a
// reference, not just a spread. Every other consumer spreads the factory call
// inline because it takes the policy wholesale.
const testPolicy = createVitestTestPolicy();

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      '@aquaculture/shared-contracts': resolve(
        __dirname,
        '../../libs/shared-contracts/src/index.ts',
      ),
      // Promoted water-chemistry compute/charts import the engine; resolve it to
      // source for shared-ui's own vitest (mirrors the vite.config build alias).
      '@platform/aquaculture-engines': resolve(
        __dirname,
        '../../libs/aquaculture-engines/src/index.ts',
      ),
      '@platform/admin-http-contracts': resolve(
        __dirname,
        '../../platform/libs/admin-http-contracts/src/index.ts',
      ),
      '@platform/identity': resolve(__dirname, '../../libs/event-contracts/src/roles.ts'),
      '@platform/tenant-permissions': resolve(
        __dirname,
        '../../libs/event-contracts/src/tenant-permissions.ts',
      ),
      '@platform/pagination-contracts': resolve(
        __dirname,
        '../../platform/libs/pagination-contracts/src/index.ts',
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
