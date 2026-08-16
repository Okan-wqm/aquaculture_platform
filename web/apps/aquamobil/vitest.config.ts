import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

import { loadVitestResourceProfile } from '../../../tools/testing/vitest-resource-policy';
import { AQUAMOBIL_SOURCE_PATH_ALIASES } from './source-path-aliases';

const resourceProfile = loadVitestResourceProfile('reactDom');

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
      ...AQUAMOBIL_SOURCE_PATH_ALIASES,
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
    testTimeout: resourceProfile.testTimeoutMs,
  },
});
