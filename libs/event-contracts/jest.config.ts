/**
 * Jest config for the `@platform/event-contracts` library.
 *
 * Until this file existed (Faz 3 follow-on), the library shipped
 * tests under `src/upcasters/__tests__/` AND
 * `src/schemas/__tests__/` that were never run by CI — Nx had no
 * project entry for the library, so `nx test event-contracts` was a
 * no-op. The schema validator landed earlier in this PR with its
 * spec parked in `apps/sensor-service/src/__tests__/` to get under
 * CI coverage immediately; this commit moves it back to its
 * architectural home.
 *
 * Same posture as the platform-wide jest preset (ts-jest transformer,
 * 60% coverage floor — opt-in via `--coverage`).
 */
export default {
  displayName: 'event-contracts',
  preset: '../../jest.preset.js',
  testEnvironment: 'node',
  transform: {
    '^.+\\.[tj]s$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.spec.json' }],
  },
  moduleFileExtensions: ['ts', 'js', 'html'],
  coverageDirectory: '../../coverage/libs/event-contracts',
};
