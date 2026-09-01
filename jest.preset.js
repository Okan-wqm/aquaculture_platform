const nxPreset = require('@nx/jest/preset').default;

module.exports = {
  ...nxPreset,
  testMatch: ['**/+(*.)+(spec|test).+(ts|js)?(x)'],
  transform: {
    '^.+\\.(ts|js|html)$': [
      'ts-jest',
      {
        tsconfig: '<rootDir>/tsconfig.spec.json',
      },
    ],
  },
  resolver: '@nx/jest/plugins/resolver',
  moduleFileExtensions: ['ts', 'js', 'html', 'tsx', 'jsx'],
  // node_modules stays untransformed EXCEPT the packages named here. Those
  // ship ESM that a Jest CJS sandbox cannot parse, while Node >=22's
  // require(esm) loads them fine at runtime — so production works and only
  // the test runner chokes. decode-uri-component@0.5.0 (the override that
  // floors past GHSA-vcc3-ghjq-m6fr) reaches every Jest project through
  // minio -> query-string; transforming that one tiny package is the
  // single-point fix. If another node_modules package ever needs ESM
  // parsing in tests, append it here — never widen the ignore pattern.
  transformIgnorePatterns: ['/node_modules/(?!(decode-uri-component)/)'],
  coverageReporters: ['html', 'text', 'lcov'],
  collectCoverageFrom: [
    '**/*.{ts,tsx}',
    '!**/*.spec.{ts,tsx}',
    '!**/*.test.{ts,tsx}',
    '!**/node_modules/**',
    '!**/dist/**',
    '!**/coverage/**',
  ],
};