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
    '^.+\\.[tj]s$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.spec.json' }],
  },
  moduleFileExtensions: ['ts', 'js', 'html'],
  coverageDirectory: '../../coverage/libs/migration-harness',
  // Long timeout for tests that boot a testcontainer (Phase 1 later commits).
  // Individual tests still enforce per-test budgets; this is the safety net.
  testTimeout: 120_000,
};
