import { defineConfig } from 'vitest/config';

import createVitestTestPolicy from '@aquaculture/testing/vitest';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';



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
    // Single-catalog i18n SSoT — mirror of the vite.config.ts alias.
    '@aquaculture/shared-ui/i18n': resolve(__dirname, '../../shared-ui/src/i18n'),
    '@aquaculture/shared-ui/brand': resolve(__dirname, '../../shared-ui/src/config/brand.ts'),
      // Standalone-build parity: workspace test policy via alias (farm-shared
      // pattern) — this app's npm ci context has no workspace links.
      '@aquaculture/testing/vitest': resolve(__dirname, '../../../libs/testing/src/vitest-test-policy'),
      // Single React instance: this app runs standalone npm ci, so the local
      // hoisted copy IS the one copy — dedupe onto it (the root-relative pin
      // only applied when node_modules was workspace-hoisted).
      'react': resolve(__dirname, 'node_modules/react'),
      'react-dom': resolve(__dirname, 'node_modules/react-dom'),
      'react/jsx-runtime': resolve(__dirname, 'node_modules/react/jsx-runtime'),
      'react/jsx-dev-runtime': resolve(__dirname, 'node_modules/react/jsx-dev-runtime'),
    },
  },
  test: {
    globals: false,
    environment: 'jsdom',
    root: resolve(__dirname),
    include: ['src/**/*.{spec,test}.{ts,tsx}'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    // Worker pool, per-test timeout and LCOV coverage come from the one policy
    // every Vitest producer in the workspace spreads (INFRA-HIGH-157).
    ...createVitestTestPolicy(),
    // WHY: jsdom transform + collect is heavy (~70s collect alone) and the suite
    // runs file-parallel. On a CPU-contended CI runner, async component specs that
    // do real work (e.g. RecordEntityPage's queue-error confirm flow) can exceed
    // the 5000ms default and flake RED even though they pass in isolation. Raising
    // the per-test timeout removes the load-induced flake without masking a real
    // failure — a genuinely hung test still trips the ceiling.
    //
    // Sourced from tools/testing/vitest-resource-policy.json's 'reactDom' profile
    // (the SSoT for vitest worker/timeout budgets) instead of a local literal, so
    // this and any future jsdom+React project tune the same knob in one place.
  },
});
