export default {
  displayName: 'messaging-service',
  preset: '../../jest.preset.js',
  testEnvironment: 'node',
  transform: {
    '^.+\\.[tj]s$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.spec.json' }],
  },
  moduleFileExtensions: ['ts', 'js', 'html'],
  coverageDirectory: '../../coverage/apps/messaging-service',
  // ORPHAN-HIGH-102: the `@nestjs/microservices` moduleNameMapper stub was
  // removed here too (it was a stale-premise hand-fork of an installed package).
  // Five feature modules register `customClass: NatsV3Client`, which eagerly
  // evaluates the backend-common/nats barrel (`NatsV3Server extends Server`);
  // the real package must load so that base class is defined under ts-jest.
};
