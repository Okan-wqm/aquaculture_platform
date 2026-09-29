/**
 * notification-service Postgres lane (ALERT-CRITICAL-004).
 *
 * Testcontainers-backed `*.postgres.spec.ts` only — the alarm delivery's
 * idempotency lives in the notification schema's unique index and command
 * receipts, which no mocked repository can prove. Runs per PR through
 * ci-affected's `test:integration` step, like alert-engine and farm-service.
 */
export default {
  displayName: 'notification-service-integration',
  preset: '../../jest.preset.js',
  testEnvironment: 'node',
  testMatch: ['<rootDir>/src/**/*.postgres.spec.ts'],
  transform: {
    '^.+\\.[tj]s$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.spec.json' }],
  },
  setupFilesAfterEnv: ['<rootDir>/jest.setup.ts'],
  moduleFileExtensions: ['ts', 'js', 'html'],
  coverageDirectory: '../../coverage/apps/notification-service-integration',
  maxWorkers: 1,
  testTimeout: 120000,
};
