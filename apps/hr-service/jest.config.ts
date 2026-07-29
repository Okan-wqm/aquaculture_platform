import coverageBaselines from '../../tools/quality/service-coverage-baselines.js';

export default {
  displayName: 'hr-service',
  preset: '../../jest.preset.js',
  testEnvironment: 'node',
  transform: {
    '^.+\\.[tj]s$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.spec.json' }],
  },
  moduleFileExtensions: ['ts', 'js', 'html'],
  coverageDirectory: '../../coverage/apps/hr-service',
  coveragePathIgnorePatterns: ['<rootDir>/src/database/migrations/.archive/'],
  coverageThreshold: { global: coverageBaselines['hr-service'] },
};
