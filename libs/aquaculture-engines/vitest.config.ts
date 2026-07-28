import testPolicy from '@aquaculture/testing/vitest';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['src/**/*.spec.ts'],
    ...testPolicy,
  },
});
