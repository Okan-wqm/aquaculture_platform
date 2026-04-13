export default {
  displayName: 'messaging-service-e2e',
  preset: '../../../jest.preset.js',
  testEnvironment: 'node',
  testMatch: ['<rootDir>/**/*.e2e-spec.ts'],
  transform: {
    '^.+\\.[tj]s$': ['ts-jest', { tsconfig: '<rootDir>/../tsconfig.spec.json' }],
  },
  moduleFileExtensions: ['ts', 'js', 'html'],
  moduleNameMapper: {
    '^@nestjs/microservices$': '<rootDir>/../src/__mocks__/@nestjs/microservices.ts',
  },
  testTimeout: 60000,
  maxWorkers: 1,
};
