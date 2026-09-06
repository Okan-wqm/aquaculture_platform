const { pathsToModuleNameMapper } = require('ts-jest');
const { compilerOptions } = require('../../tsconfig.base.json');

module.exports = {
  rootDir: '../..',
  preset: './jest.preset.js',
  displayName: 'nats-production-acl',
  testEnvironment: 'node',
  testMatch: ['<rootDir>/libs/backend-common/src/nats/__tests__/nats-production-acl.integration.spec.ts'],
  passWithNoTests: false,
  transform: {
    '^.+\\.[tj]s$': ['ts-jest', { tsconfig: '<rootDir>/libs/backend-common/tsconfig.spec.json' }],
  },
  moduleNameMapper: pathsToModuleNameMapper(compilerOptions.paths, { prefix: '<rootDir>/' }),
  testTimeout: 20000,
};
