/**
 * K10 red-team suite (PR-T1, MT-HIGH-062 / MT-HIGH-064): a tenant-A AI agent
 * attacks tenant B through the REAL ai-service runner, tools and
 * TenantBoundNatsClient, wired in-process to the REAL farm-service responders
 * and query handlers over a real two-tenant PostgreSQL (Testcontainers) with
 * the production RLS policy, connected as a role that cannot bypass it.
 *
 * A BLOCKING gate on every pull request and merge-group run: ci-affected.yml
 * job `ai-tenant-redteam` invokes this config by path with no change filter
 * (dependency-only changes included), and merge-gate and build-status fail
 * unless it succeeded (.github/manifests/main-required-status-checks.json pins
 * both needs). It also runs in ci-affected's affected `test` lane.
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
