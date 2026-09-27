// ARIA's own rule configuration for `lint-rules-adapter` (ARIA-MEDIUM-178).
//
// This is NOT the repository's developer lint (`eslint.config.mjs`): that
// one gates commits and must stay quiet. This one is the adapter's scan
// surface — every rule of the two curated packs, run in shadow, so the
// findings reach ARIA's ledger, its judges and its label queue, and the
// packs are pruned by this repository's own labels (rule by rule: a
// false-positive share above the policy floor retires a rule; below the
// ceiling promotes it) before any of it is asked of a developer.
//
// The packs are the open-source implementations of SonarSource's JS/TS
// rules (`eslint-plugin-sonarjs`, LGPL, run as a plugin and never copied)
// and `eslint-plugin-security`. No type information is given to the
// parser on purpose: type-aware rules need a `parserOptions.project` per
// workspace and multiply the scan time; the first shadow measurement is of
// the syntactic packs, and the type-aware tier is a later, measured step.
import tsParser from '@typescript-eslint/parser';
import security from 'eslint-plugin-security';
import sonarjs from 'eslint-plugin-sonarjs';

export default [
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      '**/.archive/**',
      '**/*.d.ts',
    ],
  },
  {
    // The developer lint's inline suppression comments are not this
    // configuration's business: one written for a repository rule would
    // otherwise come back as an unused-directive notice from a scan that
    // never ran that rule.
    linterOptions: { reportUnusedDisableDirectives: 'off' },
  },
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaVersion: 'latest', sourceType: 'module', ecmaFeatures: { jsx: true } },
    },
  },
  sonarjs.configs.recommended,
  security.configs.recommended,
];
