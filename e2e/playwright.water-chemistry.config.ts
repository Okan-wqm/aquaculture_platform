import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/water-chemistry',
  timeout: 45_000,
  expect: {
    timeout: 10_000,
  },
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI
    ? [['html', { open: 'never' }], ['github']]
    : [['html', { open: 'on-failure' }]],
  use: {
    baseURL: process.env.FARM_WATER_CHEMISTRY_URL ?? 'http://127.0.0.1:4302/water-chemistry',
  },
  projects: [
    {
      name: 'farm-water-chemistry',
    },
  ],
});
