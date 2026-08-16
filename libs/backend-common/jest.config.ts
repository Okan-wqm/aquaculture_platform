export default {
  displayName: 'backend-common',
  preset: '../../jest.preset.js',
  testEnvironment: 'node',
  transform: {
    '^.+\\.[tj]s$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.spec.json' }],
  },
  moduleFileExtensions: ['ts', 'js', 'html'],
  coverageDirectory: '../../coverage/libs/backend-common',
  // Two integration suites share Docker capacity with the migration harness.
  // Serial ownership prevents duplicate cold pulls and host-memory contention.
  maxWorkers: 1,
  testTimeout: 120_000,
};
