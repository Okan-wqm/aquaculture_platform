const rootConfig = require('../../../.eslintrc.json');

const typedRules =
  rootConfig.overrides.find((override) =>
    override.extends?.includes('plugin:@typescript-eslint/strict'),
  )?.rules ?? {};

module.exports = {
  root: true,
  ignorePatterns: rootConfig.ignorePatterns,
  plugins: [...rootConfig.plugins, 'react-hooks'],
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
    '@typescript-eslint/explicit-function-return-type': 'off',
    '@typescript-eslint/no-empty-function': 'off',
    '@typescript-eslint/no-misused-promises': [
      'error',
      {
        checksVoidReturn: {
          attributes: false,
        },
      },
    ],
    '@typescript-eslint/no-non-null-assertion': 'off',
    '@typescript-eslint/no-unnecessary-type-assertion': 'off',
    '@typescript-eslint/no-unsafe-assignment': 'off',
    '@typescript-eslint/no-unsafe-member-access': 'off',
    '@typescript-eslint/no-unused-vars': 'off',
    'import/order': 'off',
    'react-hooks/rules-of-hooks': 'error',
    'react-hooks/exhaustive-deps': 'off',
  },
  overrides: [
    {
      files: ['src/**/*.spec.ts', 'src/**/*.test.ts', 'src/**/__tests__/**/*'],
      rules: {
        '@typescript-eslint/no-floating-promises': 'off',
        '@typescript-eslint/no-explicit-any': 'off',
      },
    },
  ],
};
