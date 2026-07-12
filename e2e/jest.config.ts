import type { Config } from 'jest';

const config: Config = {
  displayName: 'e2e-workflow',
  testEnvironment: 'node',
  transform: {
    '^.+\\.ts$': 'ts-jest',
  },
  testMatch: ['<rootDir>/tests/**/*.spec.ts'],
  // Playwright-run suites (security, water-chemistry, mobile) are excluded —
  // the runner boundary is explicit so Jest never loads @playwright/test specs.
  testPathIgnorePatterns: [
    '/node_modules/',
    '<rootDir>/tests/security/',
    '<rootDir>/tests/water-chemistry/',
    '<rootDir>/tests/mobile/',
  ],
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
    // platform/libs/* path aliases (declared in tsconfig.base.json paths
    // but missing from this Jest moduleNameMapper). Without them ts-jest
    // cannot resolve @platform/outbox / @platform/event-bus / @platform/cqrs
    // at require()-time, with two cascading effects:
    //
    //   - apps/messaging-service/src/outbox/messaging-outbox.entity.ts
    //   - apps/hr-service/src/hr/entities/hr-outbox.entity.ts
    //   - apps/farm-service/src/outbox/farm-outbox.entity.ts
    //   all import @platform/outbox directly. require() throws and the
    //   entity drops out of the loaded class list.
    //
    //   - libs/backend-common/src/security/index.ts re-exports
    //     security-event.service.ts which imports @platform/event-bus.
    //     Any *.entity.ts that imports `@aquaculture/backend-common/security`
    //     (e.g. apps/hr-service/src/hr/entities/employee.entity.ts:17)
    //     transitively pulls @platform/event-bus and silently fails to
    //     require. Visible downstream symptom: TypeORM throws
    //     "Entity metadata for WorkRotation#employee was not found"
    //     because the string-based @ManyToOne('Employee', ...) lookup
    //     finds no Employee class in the metadata graph.
    '^@platform/outbox$': '<rootDir>/../platform/libs/outbox/src/index.ts',
    '^@platform/event-bus$': '<rootDir>/../platform/libs/event-bus/src/index.ts',
    '^@platform/cqrs$': '<rootDir>/../platform/libs/cqrs/src/index.ts',
  },
};

export default config;
