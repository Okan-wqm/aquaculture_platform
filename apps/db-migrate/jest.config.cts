const workspaceJestPreset = require('../../jest.preset.js');

module.exports = {
  ...workspaceJestPreset,
  displayName: 'db-migrate',
  testEnvironment: 'node',
  testMatch: [
    '<rootDir>/src/**/*.spec.ts',
    '<rootDir>/src/**/__tests__/**/*.spec.ts',
  ],
  transform: {
    '^.+\\.[tj]s$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.spec.json' }],
  },
  moduleFileExtensions: ['ts', 'js', 'html'],
  coverageDirectory: '../../coverage/apps/db-migrate',
  // Integration tests (`*.integration.spec.ts`) use testcontainers
  // which needs longer than the default 5s for docker pull + boot.
  testTimeout: 120_000,
};
