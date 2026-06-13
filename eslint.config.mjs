// @ts-check
/**
 * ESLint 9 flat config — faithful, zero-drift successor to `.eslintrc.json`
 * + the 30 per-project `.eslintrc.cjs` files (A2 PR-2).
 *
 * FAITHFULNESS MODEL (why this file is shaped the way it is)
 * ---------------------------------------------------------------------------
 * Under ESLint 8 every project carried its own `.eslintrc.cjs` with
 * `root: true`. `root: true` STOPS the eslintrc cascade at the project
 * boundary, so the root `.eslintrc.json` overrides (module-boundaries, the
 * gate rules, the 6 custom `aquaculture/*` rules, the React preset, the test
 * relaxations) did NOT apply inside any of those 30 projects. Each project was
 * a self-contained policy = shared TS presets + that project's own explicit
 * rules. The root overrides applied ONLY to the non-`.eslintrc.cjs` zones:
 * `platform/libs/**`, `libs/backend-common/**`, `web/apps/aquamobil/**`,
 * `tools/**`, `e2e/**`, and the repo root.
 *
 * Flat config has no `root: true`; every config object is cumulative. To
 * reproduce the cascade boundary EXACTLY we gate every root-derived override
 * with `ignores: PROJECT_GLOBS` (the 30 project trees), and re-introduce each
 * project's policy as its own `files`-scoped block sourced VERBATIM from its
 * former `.eslintrc.cjs` (see ./eslint.project-overrides.mjs). The shared TS
 * presets (`flat/recommended-type-checked` + `flat/strict`) apply everywhere
 * because every former config — project and non-project alike — extended them.
 *
 * This equivalence is PROVEN, not asserted: tools/lint-gates/eslintrc-flat-parity
 * compares the ESLint 8 resolved rule map (golden) against the ESLint 9 flat
 * resolved rule map for 74 representative files across every zone, per rule.
 * The PR-1 gate-preservation baseline (tools/lint-gates/lint-gates.spec.ts)
 * additionally proves the 10 core gates still FIRE on real fixtures.
 *
 * KNOWN, FAITHFULLY-PRESERVED QUIRKS (documented, fixed separately — never
 * silently "improved" inside a migration that promises zero drift):
 *  - The 6 custom `aquaculture/*` rules are INERT inside the 30 projects
 *    (root:true shadowed them) and live only in the non-project lib zones.
 *    Activating them platform-wide is ORPHAN-HIGH-093 (docs/reviews/orphan-findings.md).
 *  - `no-restricted-syntax` resolves inconsistently across web modules
 *    (shell/shared-ui/admin-panel/sensor-module/tenant-admin = off; the rest =
 *    the 6 selectors) and in e2e (2 selectors) — recorded as ORPHAN-MEDIUM-094.
 *
 * GLOB TRANSLATION (the #1 silent-gate-loss vector): eslintrc `files:["*.ts"]`
 * is a basename glob matching any depth; flat requires the recursive form
 * (`**` then `/` then `*.ts`). Every `files`/`ignores` array below uses it.
 *
 * Plugin loading is explicit (flat config has no string-name resolution).
 * @typescript-eslint 8.59.1 ships its own `flat/*` configs, so no
 * `typescript-eslint` meta-package is needed.
 */

import { fileURLToPath } from 'node:url';

import js from '@eslint/js';
import nx from '@nx/eslint-plugin';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import aquaculture from 'eslint-plugin-aquaculture';
import importPlugin from 'eslint-plugin-import';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import jsoncParser from 'jsonc-eslint-parser';

import { PROJECT_LINT_OVERRIDES } from './eslint.project-overrides.mjs';

const tsconfigRootDir = fileURLToPath(new URL('.', import.meta.url));

// The 30 project trees that carried a `root: true` .eslintrc.cjs. Every
// root-derived override below is `ignores`-gated on these so it does NOT leak
// into a project (exactly what `root: true` prevented under ESLint 8).
const PROJECT_GLOBS = PROJECT_LINT_OVERRIDES.map((p) => `${p.dir}/**`);

// libs/migration-harness has its OWN nested `.eslintrc.json` that `extends` the
// root (it is NOT `root: true`). Under ESLint 8, an extended parent's
// path-glob overrides (`libs/**/src/**/*.ts`) are re-based to the EXTENDING
// file's directory, so they do NOT match there — meaning the 3 lib-scoped
// `aquaculture/*` rules never applied to migration-harness, even though its
// basename-glob gate overrides (`*.ts`) did. Flat config has no such re-basing,
// so we must explicitly exclude migration-harness from the lib-scoped custom
// rules (blocks 9-11) to preserve that asymmetry. Gates still apply to it.
const CUSTOM_LIB_IGNORES = [...PROJECT_GLOBS, 'libs/migration-harness/**'];

// All non-test-file plugins referenced by per-project rule sets, registered as
// one shared map so the per-project `files` blocks (which set react/import/ts
// rules but do NOT re-import plugins) resolve their rule namespaces. Importing
// each plugin object once avoids flat config's "plugin redefined" conflict.
const SHARED_PLUGINS = {
  '@typescript-eslint': tsPlugin,
  '@nx': nx,
  import: importPlugin,
  react,
  'react-hooks': reactHooks,
  'jsx-a11y': jsxA11y,
};

// Type-aware project set for the NON-project zones, verbatim from
// .eslintrc.json line 44. Per-project blocks override `project` for their own
// tree with that project's tsconfig.eslint.json.
const TS_PROJECTS = [
  'tsconfig.base.json',
  'apps/*/tsconfig.json',
  'libs/*/tsconfig.json',
  'platform/libs/*/tsconfig.json',
  'web/*/tsconfig.json',
  'web/apps/*/tsconfig.json',
  'web/apps/*/tsconfig.*.json',
  'web/modules/*/tsconfig.json',
  'web/modules/*/tsconfig.node.json',
  'e2e/tsconfig.json',
];

// The 6 main no-restricted-syntax selectors (.eslintrc.json override 2,
// lines 107-133) — getRepository, JSON.stringify>2, 4×JWT_SECRET. Verbatim.
const RESTRICTED_SYNTAX_MAIN = [
  {
    selector: "CallExpression[callee.property.name='getRepository']",
    message:
      'Direct getRepository() bypasses TenantAwareRepository and skips tenantId injection on all find operations, creating IDOR vulnerabilities. Use getScopedRepository() instead. For cross-tenant admin operations, use getUnfilteredRepository() with explicit justification.',
  },
  {
    selector:
      "CallExpression[callee.object.name='JSON'][callee.property.name='stringify'][arguments.length>2]",
    message:
      'JSON.stringify with an indent argument produces multi-line output that breaks structured JSON logging. Use the NestJS Logger — it calls StructuredLoggerService and emits a single JSON event per log.',
  },
  {
    selector: "CallExpression[callee.property.name='get'][arguments.0.value='JWT_SECRET']",
    message:
      'JWT_SECRET reads are banned (WS2.C / ADR-016 Phase B). The platform migrated from HS256 (shared JWT_SECRET) to RS256 (auth-service signs with private key, every consumer verifies with public key) in commit 7c076361. Reintroducing JWT_SECRET reads recreates the algorithm-confusion + shared-secret-leak surface the migration eliminated. Token-CONSUMER services: import PlatformJwtModule from @aquaculture/backend-common (it wraps getJwtVerifyOptions which loads JWT_PUBLIC_KEY). Token-ISSUER (auth-service): use JWT_PRIVATE_KEY for signing; the dev-only fallback uses DEV_JWT_SECRET (a different env var).',
  },
  {
    selector: "CallExpression[callee.property.name='getOrThrow'][arguments.0.value='JWT_SECRET']",
    message:
      'JWT_SECRET reads are banned (WS2.C / ADR-016 Phase B). See the .get(\'JWT_SECRET\') message above for the migration path: PlatformJwtModule for consumers, JWT_PRIVATE_KEY for the issuer. The 2026-04-14 hydroponics-service deploy outage was a configService.getOrThrow<string>(\'JWT_SECRET\') call that crashed at boot when JWT_SECRET stopped being provisioned — this rule exists to prevent that recurrence.',
  },
  {
    selector:
      "MemberExpression[object.object.name='process'][object.property.name='env'][property.name='JWT_SECRET']",
    message:
      'process.env.JWT_SECRET reads are banned (WS2.C / ADR-016 Phase B). Use PlatformJwtModule (consumer services) or JWT_PRIVATE_KEY (auth-service issuer).',
  },
  {
    selector:
      "MemberExpression[object.object.name='process'][object.property.name='env'][computed=true][property.value='JWT_SECRET']",
    message:
      "process.env['JWT_SECRET'] reads are banned (WS2.C / ADR-016 Phase B). Use PlatformJwtModule (consumer services) or JWT_PRIVATE_KEY (auth-service issuer).",
  },
];

// The 2 test-override no-restricted-syntax selectors (.eslintrc.json override
// 14, lines 282-292) — getRepository + JSON.stringify>2. Verbatim subset.
const RESTRICTED_SYNTAX_TEST = [RESTRICTED_SYNTAX_MAIN[0], RESTRICTED_SYNTAX_MAIN[1]];

const RESTRICTED_IMPORTS_PATHS = [
  {
    name: '@aquaculture/backend-common',
    message:
      'The root @aquaculture/backend-common barrel aggregates ~25 subtrees; importing from it forces every consumer to re-invalidate on any change to any subtree. Import from the specific sub-barrel instead — @aquaculture/backend-common/auth, /guards, /database, /utils, /nats, etc. The 2026-04-23 mass-codemod (AUDIT-MEDIUM-005) split all existing consumers, and this rule keeps it that way.',
  },
  {
    name: '@platform/backend-common',
    message:
      'Same rationale as @aquaculture/backend-common — import from the specific sub-barrel (@platform/backend-common/<subtree>). Also note that @aquaculture/backend-common/<subtree> is the canonical alias platform-wide; @platform/backend-common exists as a parity alias used by only two files.',
  },
  // A4 (dead-weight, #419) added these two import bans to .eslintrc.json AFTER A2
  // branched. Carried verbatim into the flat config so the cutover preserves A4's
  // gates byte-for-byte (zero-drift). repo-hygiene-invariants.spec.ts also bans the
  // dependencies at the package.json layer.
  {
    name: 'redis',
    message:
      "The node-redis 'redis' client was removed in A4 (dead-weight): ioredis is the platform's single Redis client. Socket.IO pub/sub uses an ioredis pair via @socket.io/redis-adapter (apps/gateway-api/src/websocket/adapters/redis-io.adapter.ts). Import 'ioredis' instead. A second Redis client is double maintenance + drift surface; repo-hygiene-invariants.spec.ts also bans the dependency.",
  },
  {
    name: 'moment',
    message:
      'moment was removed in A4 (dead-weight): it is in maintenance mode (no new features) and ships a large, mutable, non-tree-shakeable API. Use date-fns (already a dependency) for formatting/parsing. repo-hygiene-invariants.spec.ts also bans the dependency.',
  },
];

// Test-file globs (.eslintrc.json override 14, line 274), recursive-form.
const TEST_FILE_GLOBS = [
  '**/*.spec.ts',
  '**/*.spec.tsx',
  '**/*.spec.js',
  '**/*.spec.jsx',
  'test/**/*.ts',
  '**/__tests__/**',
  'e2e/**/*.ts',
  'tests/**/*.ts',
];

/** Map a project's former cjs override `files` (project-relative) to repo-relative globs. */
function scopeFiles(dir, files) {
  return files.map((f) => `${dir}/${f}`);
}

// Per-project blocks (the 30 former root:true .eslintrc.cjs files). Each project
// = base presets (above) + its verbatim cjs rules, with `project` pinned to its
// own tsconfig.eslint.json. Test sub-overrides follow.
const perProjectBlocks = PROJECT_LINT_OVERRIDES.flatMap((p) => {
  const blocks = [
    {
      files: [`${p.dir}/**/*.ts`, `${p.dir}/**/*.tsx`],
      languageOptions: {
        parser: tsParser,
        parserOptions: { project: p.tsProjects, tsconfigRootDir },
      },
      plugins: SHARED_PLUGINS,
      rules: p.rules,
    },
  ];
  for (const o of p.testOverrides) {
    blocks.push({ files: scopeFiles(p.dir, o.files), rules: o.rules });
  }
  return blocks;
});

export default [
  // ── ignorePatterns (.eslintrc.json lines 3-11) ──
  {
    ignores: ['node_modules', 'dist', 'build', 'coverage', '.nx', '**/*.d.ts', '**/*.js.map'],
  },

  // ── Shared base, applies EVERYWHERE (root top-level `extends`, lines 14-16,
  //    plus the strict preset that override 2 added for all *.ts/*.tsx and
  //    every project's cjs extended too). ──
  js.configs.recommended,
  ...tsPlugin.configs['flat/recommended-type-checked'].map((cfg) => ({
    ...cfg,
    files: ['**/*.ts', '**/*.tsx'],
  })),
  ...tsPlugin.configs['flat/strict'].map((cfg) => ({
    ...cfg,
    files: ['**/*.ts', '**/*.tsx'],
  })),

  // ── Base parser + type-aware project pin for ALL ts/tsx (non-project zones
  //    use TS_PROJECTS; per-project blocks below override `project`). ──
  {
    files: ['**/*.ts', '**/*.tsx'],
    plugins: { '@typescript-eslint': tsPlugin, import: importPlugin },
    languageOptions: {
      parser: tsParser,
      parserOptions: { project: TS_PROJECTS, tsconfigRootDir },
    },
  },

  // ── Preset reconciliation (applies EVERYWHERE, like the base presets) ──
  //    ESLint 8 resolved `recommended` + `recommended-requiring-type-checking`
  //    + `strict`; ESLint 9 flat `recommended-type-checked` + `strict` differ on
  //    exactly these 7 rules — the eslintrc presets listed deprecated rules and
  //    disabled formatting core-rules (TS/Prettier own them) that the flat
  //    presets express differently. Pinned to the ESLint 8 resolved values so
  //    the shared base is byte-equivalent. Both directions matter: the four
  //    `error`s restore checks the flat presets dropped; the three `off`s
  //    prevent `no-mixed-spaces-and-tabs` / `no-extra-semi` / `no-unexpected-
  //    multiline` from flooding the whole codebase with new formatting errors.
  //    Per-project blocks (later) still override where a project relaxed one.
  //    Verified rule-for-rule by tools/lint-gates/eslintrc-flat-parity.
  {
    files: ['**/*.ts', '**/*.tsx'],
    plugins: { '@typescript-eslint': tsPlugin },
    rules: {
      '@typescript-eslint/adjacent-overload-signatures': 'error',
      '@typescript-eslint/no-empty-interface': 'error',
      '@typescript-eslint/no-inferrable-types': 'error',
      '@typescript-eslint/no-empty-function': 'error',
      'no-unexpected-multiline': 'off',
      'no-extra-semi': 'off',
      'no-mixed-spaces-and-tabs': 'off',
    },
  },

  // ── override 1: @nx/enforce-module-boundaries (NON-project only) ──
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx'],
    ignores: PROJECT_GLOBS,
    plugins: { '@nx': nx },
    rules: {
      '@nx/enforce-module-boundaries': [
        'error',
        {
          enforceBuildableLibDependency: true,
          allow: ['@aquaculture/shared-ui', '@aquaculture/shared-ui/*'],
          depConstraints: [{ sourceTag: '*', onlyDependOnLibsWithTags: ['*'] }],
        },
      ],
    },
  },

  // ── override 2: gates + type-aware tweaks (NON-project only) ──
  {
    files: ['**/*.ts', '**/*.tsx'],
    ignores: PROJECT_GLOBS,
    plugins: { '@typescript-eslint': tsPlugin, import: importPlugin },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/explicit-function-return-type': [
        'warn',
        { allowExpressions: true, allowTypedFunctionExpressions: true },
      ],
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      'import/order': [
        'error',
        {
          groups: ['builtin', 'external', 'internal', 'parent', 'sibling', 'index'],
          'newlines-between': 'always',
          alphabetize: { order: 'asc', caseInsensitive: true },
        },
      ],
      '@typescript-eslint/no-extraneous-class': ['error', { allowWithDecorator: true }],
      'no-console': ['error'],
      'no-restricted-imports': ['error', { paths: RESTRICTED_IMPORTS_PATHS }],
      'no-restricted-syntax': ['error', ...RESTRICTED_SYNTAX_MAIN],
    },
  },

  // ── overrides 3-4: web/apps type-aware project pins (aquamobil is NON-cjs) ──
  {
    files: ['web/apps/**/*.ts', 'web/apps/**/*.tsx'],
    ignores: PROJECT_GLOBS,
    languageOptions: {
      parserOptions: { project: ['web/apps/*/tsconfig.json', 'web/apps/*/tsconfig.*.json'] },
    },
  },
  {
    files: ['web/apps/aquamobil/**/*.ts', 'web/apps/aquamobil/**/*.tsx'],
    ignores: PROJECT_GLOBS,
    languageOptions: {
      parserOptions: { project: ['web/apps/aquamobil/tsconfig.eslint.json'] },
    },
  },

  // ── overrides 5-7: require-entity-schema (NON-project only) ──
  {
    files: ['apps/**/src/**/*.entity.ts'],
    ignores: PROJECT_GLOBS,
    plugins: { aquaculture },
    rules: { 'aquaculture/require-entity-schema': 'warn' },
  },
  {
    files: ['apps/farm-service/src/**/*.entity.ts'],
    ignores: [
      ...PROJECT_GLOBS,
      'apps/farm-service/src/compliance/entities/tenant-erasure-audit.entity.ts',
      'apps/farm-service/src/database/entities/audit-log.entity.ts',
      'apps/farm-service/src/outbox/farm-outbox.entity.ts',
    ],
    plugins: { aquaculture },
    rules: { 'aquaculture/require-entity-schema': 'off' },
  },
  {
    files: ['apps/hr-service/src/**/*.entity.ts'],
    ignores: [
      ...PROJECT_GLOBS,
      'apps/hr-service/src/hr/entities/hr-outbox.entity.ts',
      'apps/hr-service/src/hr/entities/payroll-audit.entity.ts',
    ],
    plugins: { aquaculture },
    rules: { 'aquaculture/require-entity-schema': 'off' },
  },

  // ── override 8: no-bare-tenant-query-key (NON-project only) ──
  {
    files: ['web/**/*.ts', 'web/**/*.tsx'],
    ignores: [...PROJECT_GLOBS, 'web/**/*.spec.ts', 'web/**/*.test.ts', 'web/**/__tests__/**'],
    plugins: { aquaculture },
    rules: { 'aquaculture/no-bare-tenant-query-key': 'warn' },
  },

  // ── override 9: no-direct-event-publish (NON-project only) ──
  {
    files: ['apps/**/src/**/*.ts', 'libs/**/src/**/*.ts', 'platform/libs/**/src/**/*.ts'],
    ignores: [
      ...CUSTOM_LIB_IGNORES,
      '**/*.spec.ts',
      '**/*.test.ts',
      '**/*.e2e.ts',
      '**/__tests__/**',
      '**/__mocks__/**',
      'platform/libs/outbox/**',
    ],
    plugins: { aquaculture },
    rules: { 'aquaculture/no-direct-event-publish': 'warn' },
  },

  // ── override 10: no-high-cardinality-metric-label (NON-project only) ──
  {
    files: ['apps/**/src/**/*.ts', 'libs/**/src/**/*.ts', 'platform/libs/**/src/**/*.ts'],
    ignores: [
      ...CUSTOM_LIB_IGNORES,
      '**/*.spec.ts',
      '**/*.test.ts',
      '**/*.e2e.ts',
      '**/__tests__/**',
      '**/__mocks__/**',
    ],
    plugins: { aquaculture },
    rules: { 'aquaculture/no-high-cardinality-metric-label': 'warn' },
  },

  // ── override 11: no-claude-sdk-raw-call (NON-project only) ──
  {
    files: ['apps/**/src/**/*.ts', 'libs/**/src/**/*.ts'],
    ignores: [
      ...CUSTOM_LIB_IGNORES,
      '**/*.spec.ts',
      '**/*.test.ts',
      '**/*.e2e.ts',
      '**/__tests__/**',
      '**/__mocks__/**',
      '**/*.interface.ts',
      '**/*.types.ts',
      'apps/ai-service/src/agent/agent-runner.service.ts',
    ],
    plugins: { aquaculture },
    rules: { 'aquaculture/no-claude-sdk-raw-call': 'warn' },
  },

  // ── override 12: no-bare-graphql-query-string (NON-project only) ──
  {
    files: ['web/**/*.ts', 'web/**/*.tsx'],
    ignores: [
      ...PROJECT_GLOBS,
      'web/**/*.spec.ts',
      'web/**/*.test.ts',
      'web/**/*.spec.tsx',
      'web/**/*.test.tsx',
      'web/**/__tests__/**',
      'web/**/__mocks__/**',
      'web/**/generated/**',
    ],
    plugins: { aquaculture },
    rules: { 'aquaculture/no-bare-graphql-query-string': 'warn' },
  },

  // ── override 13: JS files get @nx/javascript under eslintrc; its flat preset
  //    pulls the typescript-eslint meta-package (not installed). The only nx
  //    rule relied on (@nx/enforce-module-boundaries) is wired in override 1
  //    above for JS too. js.configs.recommended (applied globally) covers the
  //    rest. ──

  // ── override "*.tsx": React preset (NON-project only — projects' cjs were
  //    root:true and did NOT extend the React preset; their react-hooks/jsx-a11y
  //    rules come from their own per-project rule sets). ──
  {
    files: ['**/*.tsx'],
    ignores: PROJECT_GLOBS,
    plugins: { react, 'react-hooks': reactHooks, 'jsx-a11y': jsxA11y },
    languageOptions: { parserOptions: { ecmaFeatures: { jsx: true } } },
    settings: { react: { version: 'detect' } },
    rules: {
      ...react.configs.recommended.rules,
      ...reactHooks.configs.recommended.rules,
      ...jsxA11y.configs.recommended.rules,
      'react/react-in-jsx-scope': 'off',
      'react/prop-types': 'off',
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      'jsx-a11y/anchor-is-valid': 'warn',
    },
  },

  // ── override 14: test files RELAX strictness + redefine no-restricted-syntax
  //    to the 2-selector subset (NON-project only). ──
  {
    files: TEST_FILE_GLOBS,
    ignores: PROJECT_GLOBS,
    languageOptions: { globals: { ...globals.jest } },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/unbound-method': 'off',
      'no-console': 'off',
      'no-restricted-syntax': ['error', ...RESTRICTED_SYNTAX_TEST],
    },
  },

  // ── The 30 per-project policies (former root:true .eslintrc.cjs), verbatim. ──
  ...perProjectBlocks,

  // ── jsonc config files (migration-harness had its own .eslintrc) ──
  {
    files: ['**/*.json'],
    languageOptions: { parser: jsoncParser },
  },

  // ── libs/migration-harness/.eslintrc.json's only non-inherited rule: an
  //    @nx/dependency-checks on its package.json. Replicated verbatim so the
  //    flat cutover drops nothing (the deleted nested eslintrc carried this). ──
  {
    files: ['libs/migration-harness/package.json'],
    languageOptions: { parser: jsoncParser },
    plugins: { '@nx': nx },
    rules: {
      '@nx/dependency-checks': [
        'error',
        { ignoredFiles: ['{projectRoot}/eslint.config.{js,cjs,mjs,ts,cts,mts}'] },
      ],
    },
  },
];
