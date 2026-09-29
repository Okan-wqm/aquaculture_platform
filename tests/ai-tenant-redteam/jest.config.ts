/**
 * K10 red-team suite (PR-T1, MT-HIGH-062 / MT-HIGH-064): a tenant-A AI agent
 * attacks tenant B through the REAL ai-service runner, tools and
 * TenantBoundNatsClient, wired in-process to the REAL farm-service responders
 * and query handlers over a real two-tenant PostgreSQL (Testcontainers).
 *
 * Runs on EVERY pull request — `.github/workflows/quality-gates.yml`
 * (job `ai-tenant-redteam`) invokes this config by path, unfiltered — and in
 * the affected `test` lane of ci-affected.yml whenever ai-service,
 * farm-service or a library they share changes.
 */
export default {
  displayName: 'ai-tenant-redteam',
  preset: '../../jest.preset.js',
  testEnvironment: 'node',
  testMatch: ['<rootDir>/src/**/*.spec.ts'],
  moduleFileExtensions: ['ts', 'js', 'html'],
  coverageDirectory: '../../coverage/tests/ai-tenant-redteam',
  // One Testcontainers PostgreSQL per spec file; a cold image boot can exceed
  // 60 s and `testTimeout` also bounds `beforeAll`.
  maxWorkers: 1,
  testTimeout: 120000,
};
