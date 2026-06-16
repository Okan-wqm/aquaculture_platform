/**
 * Jest config for the `@aquaculture/shared-contracts` library.
 *
 * MSG-MEDIUM-057: until this file existed, shared-contracts had no `test`
 * target, so the messaging media MIME allowlist SSoT invariant (frozen list,
 * svg-absent, no duplicates) could not run in CI. This wires the same posture as
 * the platform-wide preset (ts-jest, node env) so the invariant ships green.
 */
export default {
  displayName: 'shared-contracts',
  preset: '../../jest.preset.js',
  testEnvironment: 'node',
  transform: {
    '^.+\\.[tj]s$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.spec.json' }],
  },
  moduleFileExtensions: ['ts', 'js', 'html'],
  coverageDirectory: '../../coverage/libs/shared-contracts',
};
