export default {
  displayName: 'backend-common',
  preset: '../../jest.preset.js',
  testEnvironment: 'node',
  transform: {
    '^.+\\.[tj]s$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.spec.json' }],
  },
  moduleFileExtensions: ['ts', 'js', 'html'],
  coverageDirectory: '../../coverage/libs/backend-common',
  // These two need a live Postgres and fail with "Driver not Connected"
  // wherever one is absent. They were never noticed because this config had
  // no runner at all (no project.json => not an Nx project => `affected` and
  // `run-many` both skipped it, so 1,359 tests in the library every service
  // depends on had never executed in CI). Wiring the project up surfaces
  // them; keeping them here would make the unit lane red for an environment
  // reason, so the unit lane declares what it is and the integration lane
  // owns them.
  testPathIgnorePatterns: ['<rootDir>/src/.*\\.integration\\.spec\\.ts$'],
};
