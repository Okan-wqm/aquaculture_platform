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
  // sanitize-html@2.17.7 — the only release that fixes the stored-XSS and
  // mutation-XSS advisories — depends on htmlparser2@^12, which is ESM-only,
  // as are its own dependencies. The nested copy lives at
  // sanitize-html/node_modules/htmlparser2, and this pattern is unanchored,
  // so the OUTER segment has to be allowed too or the inner one is never
  // reached.
  transformIgnorePatterns: [
    '/node_modules/(?!(decode-uri-component|sanitize-html|htmlparser2|domhandler|domutils|dom-serializer|domelementtype|entities)/)',
  ],
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