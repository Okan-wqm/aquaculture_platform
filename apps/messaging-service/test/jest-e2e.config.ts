export default {
  displayName: 'messaging-service-e2e',
  preset: '../../../jest.preset.js',
  testEnvironment: 'node',
  testMatch: ['<rootDir>/**/*.e2e-spec.ts'],
  transform: {
    '^.+\\.[tj]s$': ['ts-jest', { tsconfig: '<rootDir>/../tsconfig.spec.json' }],
  },
  moduleFileExtensions: ['ts', 'js', 'html'],
  moduleNameMapper: {
    '^@nestjs/microservices$': '<rootDir>/../src/__mocks__/@nestjs/microservices.ts',
  },
  // ORPHAN-HIGH-092: run the heavy one-time DB bootstrap (readiness poll +
  // migrations + extensions) ONCE here, outside the per-hook testTimeout, so a
  // cold-container boot no longer overruns the 60s hook budget and cancels the
  // job. The per-spec beforeAll's idempotent re-run is then fast.
  globalSetup: '<rootDir>/e2e-global-setup.ts',
  testTimeout: 60000,
  maxWorkers: 1,
};
