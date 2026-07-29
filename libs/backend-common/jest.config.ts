export default {
  displayName: 'backend-common',
  preset: '../../jest.preset.js',
  testEnvironment: 'node',
  transform: {
    '^.+\\.[tj]s$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.spec.json' }],
  },
  moduleFileExtensions: ['ts', 'js', 'html'],
  coverageDirectory: '../../coverage/libs/backend-common',
  // Two suites here open a TypeORM connection to a MIGRATED PostgreSQL at
  // DATABASE_HOST:DATABASE_PORT (default localhost:5432) in `beforeAll` —
  // `watchdog.integration.spec.ts` and `schema-integrity.integration.spec.ts`.
  // They are not Testcontainers suites: they expect a database that bootstrap
  // has already run against, so they cannot pass in the unit lane and fail with
  // ECONNREFUSED. Excluded by the same pattern apps/farm-service/jest.config.ts
  // uses, so `backend-common:test` is a lane that can actually be green.
  //
  // NOT a silent drop: wiring them to a migrated-DB lane is tracked as
  // PLAT-HIGH-907 (owner: Okan-Wqm, deadline 2026-08-26). Until that lands they
  // are declared-but-unrun, which is the very condition this project.json was
  // added to end — hence a finding with a date rather than a comment.
  testPathIgnorePatterns: ['/node_modules/', '\\.integration\\.spec\\.ts$'],
};
