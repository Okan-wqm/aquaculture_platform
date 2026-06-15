export default {
  displayName: 'messaging-service-e2e',
  preset: '../../../jest.preset.js',
  testEnvironment: 'node',
  testMatch: ['<rootDir>/**/*.e2e-spec.ts'],
  transform: {
    '^.+\\.[tj]s$': ['ts-jest', { tsconfig: '<rootDir>/../tsconfig.spec.json' }],
  },
  moduleFileExtensions: ['ts', 'js', 'html'],
  // ORPHAN-HIGH-102: the `@nestjs/microservices` moduleNameMapper stub was
  // removed. The real package (^11.1.19, a declared dependency) now loads, so
  // the backend-common/nats barrel's `class NatsV3Server extends Server`
  // resolves a real base class at import time instead of `undefined`. NATS is
  // isolated at the DI seam (`.overrideProvider('NATS_SERVICE')` in e2e-setup),
  // not by replacing the whole module — the idiomatic, drift-proof pattern.
  // ORPHAN-HIGH-092: run the heavy one-time DB bootstrap (readiness poll +
  // migrations + extensions) ONCE here, outside the per-hook testTimeout, so a
  // cold-container boot no longer overruns the 60s hook budget and cancels the
  // job. The per-spec beforeAll's idempotent re-run is then fast.
  globalSetup: '<rootDir>/e2e-global-setup.ts',
  testTimeout: 60000,
  maxWorkers: 1,
};
