import path from 'path';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/__tests__/**/*.test.ts'],
  },
  resolve: {
    alias: {
      '@platform/aquaculture-engines': path.resolve(__dirname, '../../libs/aquaculture-engines/src/index.ts'),
    },
  },
});
