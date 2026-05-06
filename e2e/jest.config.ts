import type { Config } from 'jest';

const config: Config = {
  displayName: 'e2e-workflow',
  testEnvironment: 'node',
  transform: {
    '^.+\\.ts$': 'ts-jest',
  },
  testMatch: ['<rootDir>/tests/**/*.spec.ts'],
  testPathIgnorePatterns: ['/node_modules/', '<rootDir>/tests/security/'],
  moduleNameMapper: {
    '^@aquaculture/backend-common$': '<rootDir>/../libs/backend-common/src/index.ts',
    '^@aquaculture/backend-common/(.*)$': '<rootDir>/../libs/backend-common/src/$1',
    '^@platform/backend-common$': '<rootDir>/../libs/backend-common/src/index.ts',
    '^@platform/shared$': '<rootDir>/../libs/shared/src/index.ts',
    '^@platform/event-contracts$': '<rootDir>/../libs/event-contracts/src/index.ts',
    '^@platform/storage$': '<rootDir>/../libs/storage/src/index.ts',
    '^@platform/testing$': '<rootDir>/../libs/testing/src/index.ts',
  },
};

export default config;
