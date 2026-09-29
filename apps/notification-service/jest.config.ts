export default {
  displayName: 'notification-service',
  preset: '../../jest.preset.js',
  testEnvironment: 'node',
  transform: {
    '^.+\\.[tj]s$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.spec.json' }],
  },
  setupFilesAfterEnv: ['<rootDir>/jest.setup.ts'],
  moduleFileExtensions: ['ts', 'js', 'html'],
  coverageDirectory: '../../coverage/apps/notification-service',
  // Testcontainers suites run in the `test:integration` lane only.
  testPathIgnorePatterns: ['/node_modules/', '\\.postgres\\.spec\\.ts$'],
};
