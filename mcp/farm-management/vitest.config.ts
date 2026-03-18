import { defineConfig } from 'vitest/config';
import path from 'path';

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
