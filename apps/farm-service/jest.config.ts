export default {
  displayName: 'farm-service',
  preset: '../../jest.preset.js',
  testEnvironment: 'node',
  transform: {
    '^.+\\.[tj]s$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.spec.json' }],
  },
  moduleFileExtensions: ['ts', 'js', 'html'],
  coverageDirectory: '../../coverage/apps/farm-service',
  testPathIgnorePatterns: [
    '/node_modules/',
    '<rootDir>/src/.*/__tests__/integration/',
    '<rootDir>/src/__tests__/e2e/',
    // NOTE: src/database/migrations/__tests__/ is intentionally NOT ignored.
    // Those specs are pure London-school unit tests (they mock QueryRunner — no
    // DB), and excluding them is exactly why the unguarded `ALTER TYPE` that took
    // production down on 2026-06-17 shipped untested (ORPHAN-MEDIUM-132). Running
    // them in the unit suite catches migration-SQL-shape regressions pre-merge.
    '\\.integration\\.spec\\.ts$',
    '\\.postgres\\.spec\\.ts$',
    '\\.e2e-spec\\.ts$',
  ],
  // coverageThreshold added: enforce 60% floor on critical service.
  // BEFORE: coverage could drop to 0% with no CI signal — admin-api-service
  // already sets this standard at 60%; extending to security/financial/safety services.
  coverageThreshold: {
    global: {
      branches: 60,
      functions: 60,
      lines: 60,
      statements: 60,
    },
  },
};
