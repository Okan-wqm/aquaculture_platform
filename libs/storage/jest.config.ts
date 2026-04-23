/**
 * Jest config for the `@platform/storage` library.
 *
 * Same posture as libs/event-contracts — matches the platform-wide
 * preset (ts-jest transformer, 60% coverage floor opt-in via
 * `--coverage`). Picks up specs under `src/__tests__/` plus any
 * `*.spec.ts` / `*.test.ts` sibling files.
 */
export default {
  displayName: 'storage',
  preset: '../../jest.preset.js',
  testEnvironment: 'node',
  transform: {
    '^.+\\.[tj]s$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.spec.json' }],
  },
  moduleFileExtensions: ['ts', 'js', 'html'],
  coverageDirectory: '../../coverage/libs/storage',
};
