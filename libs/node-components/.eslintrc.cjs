const rootConfig = require('../../.eslintrc.json');

const typedRules =
  rootConfig.overrides.find((override) =>
    override.extends?.includes('plugin:@typescript-eslint/strict'),
  )?.rules ?? {};

const moduleBoundaryRules =
  rootConfig.overrides.find((override) => override.rules?.['@nx/enforce-module-boundaries'])
    ?.rules ?? {};

module.exports = {
  root: true,
  ignorePatterns: rootConfig.ignorePatterns,
  plugins: rootConfig.plugins,
  extends: [
    ...rootConfig.extends,
    'plugin:@nx/typescript',
    'plugin:@typescript-eslint/recommended',
    'plugin:@typescript-eslint/recommended-requiring-type-checking',
    'plugin:@typescript-eslint/strict',
  ],
  parserOptions: {
    project: ['tsconfig.eslint.json'],
    tsconfigRootDir: __dirname,
    sourceType: 'module',
  },
  rules: {
    ...moduleBoundaryRules,
    ...typedRules,
    '@typescript-eslint/explicit-function-return-type': 'off',
  },
};
