const nxPreset = require('@nx/jest/preset').default;

// Packages that ship ONLY ESM and therefore must be transformed for the Jest
// CJS sandbox (see transformIgnorePatterns below for the rationale):
// - decode-uri-component@0.5.0: the override that floors past
//   GHSA-vcc3-ghjq-m6fr, reached by every Jest project through
//   minio -> query-string (SUPPLY-MEDIUM-004).
// - htmlparser2@12 and its dependency graph: pulled by the sanitize-html
//   ^2.17.7 floor past GHSA-g8qq-57p8-ggw5 (SUPPLY-HIGH-006 / SUPPLY-MEDIUM-007),
//   nested under sanitize-html/node_modules/.
const ESM_ONLY_TEST_DEPENDENCIES = [
  'decode-uri-component',
  'htmlparser2',
  'domhandler',
  'domutils',
  'dom-serializer',
  'domelementtype',
  'entities',
];

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
  // node_modules stays untransformed EXCEPT the packages named in
  // ESM_ONLY_TEST_DEPENDENCIES above. Those ship ESM that a Jest CJS sandbox
  // cannot parse, while Node >=22's require(esm) loads them fine at runtime —
  // so production works and only the test runner chokes. The pattern anchors
  // on the LAST node_modules segment of a path, because a security floor can
  // leave the ESM copy nested under its consumer (sanitize-html@2.17.7 keeps
  // htmlparser2@12 under sanitize-html/node_modules/) where a first-segment
  // allowlist would never see it. Append packages to the list — never widen
  // the ignore pattern.
  transformIgnorePatterns: [
    `/node_modules/(?!(?:.*/node_modules/)?(?:${ESM_ONLY_TEST_DEPENDENCIES.join('|')})/)`,
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
