/**
 * alert-engine Postgres lane (ALERT-CRITICAL-004 / ALERT-CRITICAL-009).
 *
 * Testcontainers-backed `*.postgres.spec.ts` only — the farm-signal incident
 * schema (rule_id/signal_key xor, one open incident per signal) and the default
 * escalation policy seed/reconcile are database invariants that no mocked
 * repository can prove. Runs per PR through ci-affected's `test:integration`
 * step, like farm-service and auth-service.
 */
export default {
  displayName: 'alert-engine-integration',
  preset: '../../jest.preset.js',
  testEnvironment: 'node',
  testMatch: ['<rootDir>/src/**/*.postgres.spec.ts'],
  transform: {
    '^.+\\.[tj]s$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.spec.json' }],
  },
  moduleFileExtensions: ['ts', 'js', 'html'],
  coverageDirectory: '../../coverage/apps/alert-engine-integration',
  maxWorkers: 1,
  testTimeout: 120000,
};
