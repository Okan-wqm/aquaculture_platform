export default {
  displayName: 'e2e',
  testEnvironment: 'node',
  transform: {
    '^.+\\.[tj]s$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json' }],
  },
  moduleFileExtensions: ['ts', 'js', 'json'],
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
