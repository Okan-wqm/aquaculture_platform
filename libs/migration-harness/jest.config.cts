module.exports = {
  displayName: 'migration-harness',
  preset: '../../jest.preset.js',
  testEnvironment: 'node',
  // Pick up both the Nx default (**/*.spec.ts) AND the repo convention
  // __tests__ subdirectory used across libs/backend-common.
  testMatch: [
    '<rootDir>/src/**/*.spec.ts',
    '<rootDir>/src/**/__tests__/**/*.spec.ts',
  ],
  transform: {
    // isolatedModules lives in tsconfig.spec.json (compilerOptions) —
    // ts-jest v29+ deprecates passing it here. Skips full cross-module
    // type-checking; when the harness imports from @aquaculture/backend-
    // common it would otherwise pull the entire source tree through the
    // type-checker + surface pre-existing TS4111/TS2532 noise. Type
    // safety still covered by nx run backend-common:build.
    '^.+\\.[tj]s$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.spec.json' }],
  },
  moduleFileExtensions: ['ts', 'js', 'html'],
  coverageDirectory: '../../coverage/libs/migration-harness',
  // 2026-05-05: Integration suites boot real PostgreSQL Testcontainers.
  // Run them serially so CI does not start many Docker pulls/containers at
  // once and time out before beforeAll can hand back a usable DataSource.
  maxWorkers: 1,
  // Long timeout for tests that boot a testcontainer (Phase 1 later commits).
  // Individual tests still enforce per-test budgets; this is the safety net.
  testTimeout: 120_000,
};
