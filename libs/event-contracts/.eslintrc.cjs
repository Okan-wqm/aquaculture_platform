const rootConfig = require('../../.eslintrc.json');

const typedRules =
  rootConfig.overrides.find((override) =>
    override.extends?.includes('plugin:@typescript-eslint/strict'),
  )?.rules ?? {};

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
    ...typedRules,
    '@typescript-eslint/no-unnecessary-type-assertion': 'off',
    'import/order': 'off',
  },
  overrides: [
    {
      files: ['src/**/*.spec.ts', 'src/**/*.test.ts', 'src/**/__tests__/**/*.ts'],
      rules: {
        '@typescript-eslint/no-dynamic-delete': 'off',
        '@typescript-eslint/no-unsafe-assignment': 'off',
      },
    },
  ],
};
