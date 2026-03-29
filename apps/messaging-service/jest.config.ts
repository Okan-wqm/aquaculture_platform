export default {
  displayName: 'messaging-service',
  preset: '../../jest.preset.js',
  testEnvironment: 'node',
  transform: {
    '^.+\\.[tj]s$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.spec.json' }],
  },
  moduleFileExtensions: ['ts', 'js', 'html'],
  coverageDirectory: '../../coverage/apps/messaging-service',
  moduleNameMapper: {
    '^@nestjs/microservices$': '<rootDir>/src/__mocks__/@nestjs/microservices.ts',
  },
};
