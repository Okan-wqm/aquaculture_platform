import coverageBaselines from '../../tools/quality/service-coverage-baselines.js';

export default {
  displayName: 'auth-service',
  preset: '../../jest.preset.js',
  testEnvironment: 'node',
  transform: {
    '^.+\\.[tj]s$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.spec.json' }],
  },
  moduleFileExtensions: ['ts', 'js', 'html'],
  coverageDirectory: '../../coverage/apps/auth-service',
  // Real-Postgres migration contracts have an explicit, serial integration
  // target. Keep Docker/Testcontainers out of the fast unit target.
  testPathIgnorePatterns: ['\\.postgres\\.spec\\.ts$'],
  // AUDIT-MEDIUM-015 mock hygiene: without these, jest.spyOn/mock state leaks
  // across the service's spec files. restoreMocks restores spied originals and
  // clearMocks resets call counts between tests. resetMocks stays FALSE on
  // purpose — resetMocks:true wipes mockReturnValue/mockImplementation primed in
  // beforeEach (token.service.spec / authentication.service.spec rely on that).
  restoreMocks: true,
  clearMocks: true,
  resetMocks: false,
  coverageThreshold: { global: coverageBaselines['auth-service'] },
};
