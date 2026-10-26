// ARIA's own rule configuration for `lint-rules-adapter` (ARIA-MEDIUM-178).
//
// This is NOT the repository's developer lint (`eslint.config.mjs`): that
// one gates commits and must stay quiet. This one is the adapter's scan
// surface — every rule of the three curated packs, run in shadow, so the
// findings reach ARIA's ledger, its judges and its label queue, and the
// packs are pruned by this repository's own labels (rule by rule: a
// false-positive share above the policy floor retires a rule; below the
// ceiling promotes it) before any of it is asked of a developer.
//
// The packs are the open-source implementations of SonarSource's JS/TS
// rules (`eslint-plugin-sonarjs`, LGPL, run as a plugin and never copied),
// `eslint-plugin-security`, and the repository-policy pack below. No type
// information is given to the parser on purpose: type-aware rules need a
// `parserOptions.project` per workspace and multiply the scan time; the
// first shadow measurement is of the syntactic packs, and the type-aware
// tier is a later, measured step.
//
// The repository-policy pack carries what CLAUDE.md names FORBIDDEN where
// the developer lint does not enforce it (its per-project overrides switch
// `no-console` and `no-explicit-any` off in 17 of 31 projects, farm-service
// and hr-service among them, and nothing bans a double assertion): a
// console call, an explicit `any`, and `as unknown as T`. It applies to the
// backend roots uniformly — CLAUDE.md is the owner of the policy, so this
// file does not copy the per-project table — and it leaves web out (a
// separate decision, measured on its own) and spec files out (the files
// `TEST_FILE_RE` in lint-rules-adapter.ts classifies as tests; the adapter
// test pins that a spec file draws no policy finding).
import tsPlugin from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import security from 'eslint-plugin-security';
import sonarjs from 'eslint-plugin-sonarjs';

// `x as unknown as T` tells the compiler to stop checking: the first
// assertion erases what `x` is, the second claims what it is not. CLAUDE.md
// forbids it ("fix the type or write a generic"), and nothing else in the
// repository's lint bans it, so the rule is ARIA's own. It keeps an id of its
// own, `aria-policy/no-double-type-assertion`, instead of the shared
// `no-restricted-syntax`: a finding's rule id selects its judgment contract in
// the manifest, and a shared id would give every restricted selector in the
// repository the same contract.
//
// The finding sits on the `unknown` keyword, not on the outer assertion: an
// expression that opens lines before `as unknown as T` (an object literal, a
// function body) would otherwise be cited at its opening line, and the
// manifest contract judges the bytes of the cited line, which must be the one
// that carries the construct. A justified next-line suppression comment for
// such an expression therefore goes on the line above `as unknown`.
const noDoubleTypeAssertion = {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      doubleAssertion:
        "Double type assertion through 'unknown' (an assertion to unknown, then to another type) switches the type checker off; CLAUDE.md forbids it. Fix the type or write a generic.",
    },
  },
  create(context) {
    return {
      TSAsExpression(node) {
        const inner = node.expression;
        if (inner.type === 'TSAsExpression' && inner.typeAnnotation.type === 'TSUnknownKeyword') {
          context.report({ node: inner.typeAnnotation, messageId: 'doubleAssertion' });
        }
      },
    };
  },
};

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
    // The policy plugins are registered for every file, the rules are enabled
    // below for the backend only. A suppression comment that names a rule of an
    // unregistered plugin is itself reported as a finding of that rule
    // ("Definition for rule ... was not found"), so registering the plugin only
    // where the rule runs would turn every deliberate exception in web or in a
    // spec file into a finding.
    plugins: {
      '@typescript-eslint': tsPlugin,
      'aria-policy': { rules: { 'no-double-type-assertion': noDoubleTypeAssertion } },
    },
  },
  sonarjs.configs.recommended,
  security.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    ignores: ['web/**', '**/*.{spec,test}.{ts,tsx}'],
    rules: {
      'no-console': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      'aria-policy/no-double-type-assertion': 'error',
    },
  },
];
