import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import createVitestTestPolicy from '@aquaculture/testing/vitest';

// AquaMobil owns React, React DOM and its testing library in its standalone
// install. External CommonJS renderer imports resolve through that package's
// node_modules and cannot be redirected by Vite aliases. Component imports,
// including aliased shared source, must resolve to the same app-owned runtime.
const requireFromApp = createRequire(resolve(__dirname, 'package.json'));
const reactDirectory = dirname(requireFromApp.resolve('react/package.json'));
const reactDomDirectory = dirname(requireFromApp.resolve('react-dom/package.json'));

export default defineConfig({
  root: resolve(__dirname),
  plugins: [react()],
  resolve: {
    dedupe: ['react', 'react-dom'],
    alias: {
      '@': resolve(__dirname, 'src'),
      '@aquaculture/farm-shared': resolve(__dirname, '../../../libs/farm-shared/src'),
      // MSG-MEDIUM-057: mirror the vite.config.ts alias so the shared MIME
      // allowlist SSoT resolves under vitest too (this config has its own alias
      // block, separate from vite.config.ts).
      '@aquaculture/shared-contracts': resolve(__dirname, '../../../libs/shared-contracts/src'),
      react: reactDirectory,
      'react-dom': reactDomDirectory,
    },
  },
  test: {
    globals: false,
    environment: 'jsdom',
    include: ['src/**/*.{spec,test}.{ts,tsx}'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    // Worker pool, per-test timeout and LCOV coverage come from the one policy
    // every Vitest producer in the workspace spreads (INFRA-HIGH-157). The
    // former tools/testing resource profile was a second copy of the same
    // knobs with a single consumer — this file — and no CI runner ever read
    // it, because this project declared no `test` target.
    ...createVitestTestPolicy(),
  },
});
