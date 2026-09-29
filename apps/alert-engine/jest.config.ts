export default {
  displayName: 'alert-engine',
  preset: '../../jest.preset.js',
  testEnvironment: 'node',
  transform: {
    '^.+\\.[tj]s$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.spec.json' }],
  },
  moduleFileExtensions: ['ts', 'js', 'html'],
  coverageDirectory: '../../coverage/apps/alert-engine',
  // Testcontainers suites run in the `test:integration` lane only.
  testPathIgnorePatterns: ['/node_modules/', '\\.postgres\\.spec\\.ts$'],
};
