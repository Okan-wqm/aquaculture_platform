import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

import { loadVitestResourceProfile } from '../../../tools/testing/vitest-resource-policy';
import { AQUAMOBIL_SOURCE_ALIAS_AUTHORITY } from './source-alias-authority';

const resourceProfile = loadVitestResourceProfile('reactDom');

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      ...AQUAMOBIL_SOURCE_ALIAS_AUTHORITY,
    },
    // The production and test graphs share one React resolution rule. Dedupe
    // resolves from the active AquaMobil package whether npm hoists the
    // workspace or installs it standalone; hard-coding either node_modules
    // location makes the other topology load a second React dispatcher.
    dedupe: ['react', 'react-dom'],
  },
  test: {
    globals: false,
    environment: 'jsdom',
    setupFiles: [resolve(__dirname, 'src/test/setup.ts')],
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
