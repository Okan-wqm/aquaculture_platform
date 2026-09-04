import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';
import createVitestTestPolicy from '@aquaculture/testing/vitest';

// WHY: Aquamobil has its own node_modules/react (hoisted differently from root).
// @testing-library/react (in root node_modules) imports react-dom from root,
// while component code resolves to the local copy. This creates the classic
// dual-React-instance error ("Cannot read properties of null (reading 'useState')").
// Pinning react + react-dom to the ROOT copy ensures all imports share a single
// React instance — @testing-library and component code both use the same one.
const rootNodeModules = resolve(__dirname, '../../../node_modules');

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      '@aquaculture/farm-shared': resolve(__dirname, '../../../libs/farm-shared/src'),
      // MSG-MEDIUM-057: mirror the vite.config.ts alias so the shared MIME
      // allowlist SSoT resolves under vitest too (this config has its own alias
      // block, separate from vite.config.ts).
      '@aquaculture/shared-contracts': resolve(__dirname, '../../../libs/shared-contracts/src'),
      react: resolve(rootNodeModules, 'react'),
      'react-dom': resolve(rootNodeModules, 'react-dom'),
      'react/jsx-runtime': resolve(rootNodeModules, 'react/jsx-runtime'),
      'react/jsx-dev-runtime': resolve(rootNodeModules, 'react/jsx-dev-runtime'),
    },
  },
  test: {
    globals: false,
    environment: 'jsdom',
    root: resolve(__dirname),
    include: ['src/**/*.{spec,test}.{ts,tsx}'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    // Worker pool, per-test timeout and LCOV coverage come from the one policy
    // every Vitest producer in the workspace spreads (INFRA-HIGH-140). The
    // former tools/testing resource profile was a second copy of the same
    // knobs with a single consumer — this file — and no CI runner ever read
    // it, because this project declared no `test` target.
    ...createVitestTestPolicy(),
  },
});
