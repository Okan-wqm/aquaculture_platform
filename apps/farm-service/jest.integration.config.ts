export default {
  displayName: 'farm-service-integration',
  preset: '../../jest.preset.js',
  testEnvironment: 'node',
  testMatch: [
    '<rootDir>/src/**/__tests__/integration/**/*.spec.ts',
    '<rootDir>/src/**/*.integration.spec.ts',
    '<rootDir>/src/**/*.postgres.spec.ts',
    '<rootDir>/src/__tests__/e2e/race-conditions.spec.ts',
  ],
  transform: {
    '^.+\\.[tj]s$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.spec.json' }],
  },
  moduleFileExtensions: ['ts', 'js', 'html'],
  coverageDirectory: '../../coverage/apps/farm-service-integration',
  maxWorkers: 1,
  testTimeout: 60000,
};
