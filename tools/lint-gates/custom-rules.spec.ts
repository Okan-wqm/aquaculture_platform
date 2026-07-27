#!/usr/bin/env ts-node
/**
 * RuleTester units for the 7 custom eslint-plugin-aquaculture rules.
 *
 * WHY this exists: before this file, the architectural-invariant rules
 * (require-entity-schema, no-bare-tenant-query-key, no-direct-event-publish,
 * no-high-cardinality-metric-label, no-claude-sdk-raw-call,
 * no-bare-graphql-query-string, no-unpinned-ssrf-fetch) had ZERO tests. The ESLint 8 -> 9 flat
 * config migration (A2) keeps the SAME rule sources but re-wires how the
 * plugin is loaded; these units pin each rule's firing behaviour by
 * `messageId` so a load/registration regression in PR-2 is caught.
 *
 * All 6 rules are pure AST-selector rules (none call getParserServices), so
 * the type-info-free `@typescript-eslint/parser` is sufficient — no tsconfig
 * project is wired. The rules are imported from source (ts-node resolves
 * them) so the test tracks the source of truth, not the built `dist/`.
 *
 * RuleTester is bound to node:test (the repo's tools/gates runner) by mapping
 * its `it`/`describe` hooks onto node:test — RuleTester then drives the cases.
 */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';

import { RuleTester } from 'eslint';

import { rules } from '../eslint-rules';
import noBareGraphqlQueryString from '../eslint-rules/rules/no-bare-graphql-query-string';
import noBareTenantQueryKey from '../eslint-rules/rules/no-bare-tenant-query-key';
import noClaudeSdkRawCall from '../eslint-rules/rules/no-claude-sdk-raw-call';
import noDirectEventPublish from '../eslint-rules/rules/no-direct-event-publish';
import noHighCardinalityMetricLabel from '../eslint-rules/rules/no-high-cardinality-metric-label';
import noUnpinnedSsrfFetch from '../eslint-rules/rules/no-unpinned-ssrf-fetch';
import requireEntitySchema from '../eslint-rules/rules/require-entity-schema';

// Bind RuleTester's static hooks to node:test so the cases run under the
// repo's tools/gates ts-node runner (which has no global it/describe).
// The hooks are runtime-settable but absent from RuleTester's published
// type; widen the static type to assign them (intersection cast, not
// `as unknown as` — no type-safety hole).
type RuleTesterStatic = typeof RuleTester & {
  it: typeof it;
  describe: typeof describe;
};
(RuleTester as RuleTesterStatic).it = it;
(RuleTester as RuleTesterStatic).describe = describe;

// RuleTester's config shape changed at ESLint v9 (eslintrc `parser: <path>` ->
// flat `languageOptions: { parser: <module> }`). The gate runs under whichever
// ESLint is installed (8 in local dev, 9 in CI), so pick the shape by major.
const require_ = createRequire(__filename);
const eslintPkg = require_('eslint/package.json') as { version: string };
const eslintMajor = parseInt(eslintPkg.version, 10);
type TesterConfig = ConstructorParameters<typeof RuleTester>[0];
// The two config shapes are mutually-exclusive types across ESLint majors, and
// which branch needs a cast flips with the installed major. CI runs ESLint 9
// (the gate authority): the v9 flat shape is assignable to RuleTester.Config
// as-is, while the v8 eslintrc shape needs the assertion. (Under local ESLint 8
// the necessity flips, but the husky gate runs these specs, it does not lint
// them — CI is where no-unnecessary-type-assertion adjudicates.)
const ruleTesterConfig: TesterConfig =
  eslintMajor >= 9
    ? {
        languageOptions: {
          parser: require_('@typescript-eslint/parser') as object,
          ecmaVersion: 2022,
          sourceType: 'module',
        },
      }
    : ({
        parser: require_.resolve('@typescript-eslint/parser'),
        parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
      } as TesterConfig);
const ruleTester = new RuleTester(ruleTesterConfig);

// Each rule is an ESLintUtils.RuleCreator output (standard ESLint rule
// object); the `as never` casts bridge the @typescript-eslint Rule type to
// ESLint core's RuleModule type that RuleTester.run expects.
const asRule = (r: unknown): never => r as never;

const testedRuleNames = [
  'require-entity-schema',
  'no-bare-tenant-query-key',
  'no-direct-event-publish',
  'no-high-cardinality-metric-label',
  'no-claude-sdk-raw-call',
  'no-bare-graphql-query-string',
  'no-unpinned-ssrf-fetch',
] as const;

void it('has a RuleTester suite for every exported rule', () => {
  assert.deepEqual(Object.keys(rules).sort(), [...testedRuleNames].sort());
});

ruleTester.run('require-entity-schema', asRule(requireEntitySchema), {
  valid: [
    { code: "@Entity('users', { schema: 'auth' }) class A {}" },
    { code: "@Entity({ name: 'users', schema: 'auth' }) class B {}" },
    // NOTE: the rule's `exemptPatterns` option is dead (create() never reads
    // it — see review doc / ORPHAN-LOW); exemption is enforced purely by the
    // .eslintrc file-pattern overrides, so a `.spec.ts` @Entity() is NOT
    // exempt at the rule level. We therefore do not assert a filename-exempt
    // valid case here; scope is pinned by lint-gates.spec.ts config snapshot.
  ],
  invalid: [
    { code: '@Entity() class A {}', errors: [{ messageId: 'missingSchemaOption' }] },
    { code: "@Entity('users') class B {}", errors: [{ messageId: 'missingSchemaOption' }] },
  ],
});

ruleTester.run('no-bare-tenant-query-key', asRule(noBareTenantQueryKey), {
  valid: [{ code: "const o = { queryKey: createTenantQueryKey('farms') };" }],
  invalid: [
    { code: "const o = { queryKey: ['farms'] };", errors: [{ messageId: 'bareQueryKey' }] },
    { code: 'const o = { queryKey: [tenantId] };', errors: [{ messageId: 'tenantIdNotPrefix' }] },
  ],
});

ruleTester.run('no-direct-event-publish', asRule(noDirectEventPublish), {
  valid: [
    { code: 'outbox.publish(evt);' },
    // filename-based exemption: test files are not linted.
    { code: 'eventBus.publish(evt);', filename: 'apps/x/src/foo.spec.ts' },
  ],
  invalid: [
    { code: 'eventBus.publish(evt);', errors: [{ messageId: 'directEventBusPublish' }] },
    { code: 'natsClient.publish(subj, data);', errors: [{ messageId: 'directNatsClientPublish' }] },
  ],
});

ruleTester.run('no-high-cardinality-metric-label', asRule(noHighCardinalityMetricLabel), {
  valid: [{ code: "const m = { labelNames: ['method', 'status_code'] };" }],
  invalid: [
    {
      code: "const m = { labelNames: ['user_id'] };",
      errors: [{ messageId: 'unboundedCardinalityLabel' }],
    },
  ],
});

ruleTester.run('no-claude-sdk-raw-call', asRule(noClaudeSdkRawCall), {
  valid: [{ code: "import { wrap } from './anthropic-wrapper';" }],
  invalid: [
    {
      code: "import Anthropic from '@anthropic-ai/sdk';",
      errors: [{ messageId: 'rawAnthropicImport' }],
    },
  ],
});

ruleTester.run('no-bare-graphql-query-string', asRule(noBareGraphqlQueryString), {
  valid: [{ code: 'const q = useGqlOperation();' }],
  invalid: [
    { code: 'const q = gql`query { me { id } }`;', errors: [{ messageId: 'bareGqlTag' }] },
  ],
});

ruleTester.run('no-unpinned-ssrf-fetch', asRule(noUnpinnedSsrfFetch), {
  valid: [
    {
      code: 'await ssrfValidator.safeFetch(url);',
      filename: 'apps/notification-service/src/notification/notification-dispatcher.service.ts',
    },
    {
      code: "await fetch('https://internal.example.test/health');",
      filename: 'apps/notification-service/src/notification/webhook-sender.service.ts',
    },
    {
      code: 'await fetch(url);',
      filename: 'apps/notification-service/src/notification/webhook-sender.service.spec.ts',
    },
  ],
  invalid: [
    {
      code: 'await fetch(url);',
      filename: 'apps/notification-service/src/notification/webhook-sender.service.ts',
      errors: [{ messageId: 'bareFetchInSensitiveZone' }],
    },
    {
      code: 'const options = ssrfValidator.getSafeFetchOptions();',
      errors: [{ messageId: 'removedGetSafeFetchOptions' }],
    },
  ],
});
