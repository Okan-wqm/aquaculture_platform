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
  },
  overrides: [
    {
      files: ['src/__tests__/**/*.ts'],
      rules: {
        '@typescript-eslint/no-non-null-assertion': 'off',
        '@typescript-eslint/no-explicit-any': 'off',
        '@typescript-eslint/no-unsafe-argument': 'off',
        '@typescript-eslint/no-unsafe-assignment': 'off',
        '@typescript-eslint/no-unsafe-member-access': 'off',
        '@typescript-eslint/no-unused-vars': 'off',
        '@typescript-eslint/explicit-function-return-type': 'off',
        'no-console': 'off',
      },
    },
    {
      files: ['src/tools/**/*.ts'],
      rules: {
        '@typescript-eslint/no-explicit-any': 'off',
        '@typescript-eslint/no-non-null-assertion': 'off',
        '@typescript-eslint/no-unsafe-argument': 'off',
        '@typescript-eslint/no-unsafe-assignment': 'off',
        '@typescript-eslint/no-unsafe-member-access': 'off',
        '@typescript-eslint/no-unsafe-return': 'off',
        '@typescript-eslint/no-unused-vars': 'off',
        '@typescript-eslint/require-await': 'off',
        '@typescript-eslint/restrict-template-expressions': 'off',
        'import/order': 'off',
      },
    },
    {
      files: ['src/server.ts'],
      rules: {
        '@typescript-eslint/no-unused-vars': 'off',
        '@typescript-eslint/require-await': 'off',
      },
    },
    {
      files: [
        'src/analytics/**/*.ts',
        'src/auth/session-context.ts',
        'src/graphql/client.ts',
        'src/knowledge/**/*.ts',
      ],
      rules: {
        '@typescript-eslint/no-non-null-assertion': 'off',
        '@typescript-eslint/no-unused-vars': 'off',
      },
    },
    {
      files: ['src/index.ts'],
      rules: {
        'no-console': ['error', { allow: ['error'] }],
      },
    },
    {
      files: ['src/utils/stats.ts'],
      rules: {
        '@typescript-eslint/no-non-null-assertion': 'off',
      },
    },
    {
      files: ['src/utils/logger.ts'],
      rules: {
        'no-console': ['error', { allow: ['error'] }],
      },
    },
  ],
};
