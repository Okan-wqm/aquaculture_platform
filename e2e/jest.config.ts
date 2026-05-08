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
    // Explicit subpath mappings resolve to <subpath>/index.ts (matching
    // the tsconfig.base.json paths declarations). Listed BEFORE the
    // generic catch-all so Jest picks the index file rather than a
    // directory path that ts-jest cannot follow.
    '^@aquaculture/backend-common/database$': '<rootDir>/../libs/backend-common/src/database/index.ts',
    '^@aquaculture/backend-common/auth$': '<rootDir>/../libs/backend-common/src/auth/index.ts',
    '^@aquaculture/backend-common/audit$': '<rootDir>/../libs/backend-common/src/audit/index.ts',
    '^@aquaculture/backend-common/bootstrap$': '<rootDir>/../libs/backend-common/src/bootstrap/index.ts',
    '^@aquaculture/backend-common/config$': '<rootDir>/../libs/backend-common/src/config/index.ts',
    '^@aquaculture/backend-common/decorators$': '<rootDir>/../libs/backend-common/src/decorators/index.ts',
    '^@aquaculture/backend-common/security$': '<rootDir>/../libs/backend-common/src/security/index.ts',
    '^@aquaculture/backend-common/tenant$': '<rootDir>/../libs/backend-common/src/tenant/index.ts',
    '^@aquaculture/backend-common/utils$': '<rootDir>/../libs/backend-common/src/utils/index.ts',
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
