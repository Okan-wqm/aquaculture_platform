import path from 'path';

import createVitestTestPolicy from '@aquaculture/testing/vitest';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    ...createVitestTestPolicy(),
    include: ['src/__tests__/**/*.test.ts'],
  },
  resolve: {
    alias: {
      '@platform/aquaculture-engines': path.resolve(
        __dirname,
        '../../libs/aquaculture-engines/src/index.ts',
      ),
    },
  },
});
