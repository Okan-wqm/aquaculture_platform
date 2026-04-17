/**
 * Jest config for `tests/invariants/**` — always-on invariant suite.
 *
 * Runs under Nx via `nx test invariants` (see sibling project.json).
 * Not scoped by `nx affected` — these invariants must run on every PR,
 * not only when code under the invariant's scope happens to change,
 * because the invariant surface itself (e.g., which services are
 * schema-owning) is cross-cutting and drift detection requires
 * unconditional execution.
 *
 * Plan ref: /root/.claude/plans/declarative-riding-shamir.md D.2
 */

export default {
  displayName: 'invariants',
  preset: '../../jest.preset.js',
  testEnvironment: 'node',
  testMatch: ['<rootDir>/**/*.spec.ts'],
  transform: {
    '^.+\\.[tj]s$': [
      'ts-jest',
      {
        tsconfig: '<rootDir>/tsconfig.spec.json',
      },
    ],
  },
  moduleFileExtensions: ['ts', 'js', 'html'],
  passWithNoTests: false,
};
