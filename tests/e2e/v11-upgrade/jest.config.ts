export default {
  displayName: 'v11-upgrade-e2e',
  testEnvironment: 'node',
  transform: {
    '^.+\\.[tj]s$': [
      'ts-jest',
      { tsconfig: '<rootDir>/tsconfig.json' },
    ],
  },
  moduleFileExtensions: ['ts', 'js', 'html'],
  testMatch: ['**/*.e2e-spec.ts'],
  moduleNameMapper: {
    '^@aquaculture/backend-common$': '<rootDir>/../../../libs/backend-common/src/index.ts',
    '^@platform/backend-common$': '<rootDir>/../../../libs/backend-common/src/index.ts',
    '^@platform/cqrs$': '<rootDir>/../../../platform/libs/cqrs/src/index.ts',
    '^@platform/event-bus$': '<rootDir>/../../../platform/libs/event-bus/src/index.ts',
    '^@platform/event-contracts$': '<rootDir>/../../../libs/event-contracts/src/index.ts',
    // backend-common's tenant-aware-schemas.ts derives from the topology SSoT.
    '^@platform/service-catalog$':
      '<rootDir>/../../../platform/libs/service-catalog/src/index.ts',
  },
  // Longer timeout for NestJS app bootstrap
  testTimeout: 30_000,
};
