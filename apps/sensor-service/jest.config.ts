import coverageBaselines from '../../tools/quality/service-coverage-baselines.js';

export default {
  displayName: 'sensor-service',
  preset: '../../jest.preset.js',
  testEnvironment: 'node',
  transform: {
    '^.+\\.[tj]s$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.spec.json' }],
  },
  moduleFileExtensions: ['ts', 'js', 'html'],
  coverageDirectory: '../../coverage/apps/sensor-service',
  coverageThreshold: { global: coverageBaselines['sensor-service'] },
};
