import type { Config } from 'jest';

const config: Config = {
  displayName: 'e2e-integration',
  testEnvironment: 'node',
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json' }],
  },
  testMatch: ['<rootDir>/tests/integration/**/*.spec.ts'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  testTimeout: 60000,
  // Run integration tests serially -- they share DB state
  maxWorkers: 1,
};

export default config;
