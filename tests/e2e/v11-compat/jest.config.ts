export default {
  displayName: 'v11-compat-e2e',
  testEnvironment: 'node',
  transform: {
    '^.+\\.[tj]s$': [
      'ts-jest',
      { tsconfig: '<rootDir>/tsconfig.json' },
    ],
  },
  moduleFileExtensions: ['ts', 'js', 'html'],
  testMatch: ['**/*.e2e-spec.ts'],
  // Longer timeout for NestJS app bootstrap
  testTimeout: 30_000,
  // NestJS internal HTTP listeners may not close immediately; force clean exit
  forceExit: true,
};
