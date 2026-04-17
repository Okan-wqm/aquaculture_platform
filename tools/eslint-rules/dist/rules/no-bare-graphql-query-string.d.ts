/**
 * no-bare-graphql-query-string — enforces contract-parity-enforcer's
 * "typed-document-node mandate" invariant.
 *
 * Raw `gql`...`` template literals produce a DocumentNode whose runtime
 * shape is untyped. The TanStack Query / Apollo / urql integration that
 * consumes it ends up typed as `any` or `Record<string, unknown>`, which
 * defeats the federated-schema contract: a breaking server-side rename
 * compiles clean on the web side and only surfaces as a runtime field
 * "undefined" mid-response.
 *
 * typed-document-node (via graphql-codegen) solves this: the codegen
 * pipeline reads the GraphQL schema + `gql` call sites, emits a
 * strongly-typed `TypedDocumentNode<TResult, TVariables>` constant per
 * query, and the consumer imports THAT constant instead of a raw gql
 * literal. Apollo / TanStack Query infer data + variable types from the
 * TypedDocumentNode directly. Schema-level breaking changes surface at
 * TypeScript compile time. Contract parity held.
 *
 * Rule mechanics:
 *   - Match `TaggedTemplateExpression` whose tag is the `gql` identifier
 *     (or a member expression ending in `.gql`).
 *   - In scope only for `web/**\/*.{ts,tsx}` (the rule is about
 *     client-side contract type safety; server-side resolvers use
 *     code-first NestJS decorators, out-of-scope).
 *   - Exemptions: test files, mocks, and generated/* (the codegen
 *     output imports gql internally).
 *
 * Current baseline: ~50 raw `gql` call sites across farm-module,
 * sensor-module, admin-panel, dashboard. Phase 8.4 of the post-audit
 * plan (docs/plans/2026-04-17-…#Phase-8) activates graphql-codegen and
 * mass-migrates these to TypedDocumentNode. This rule catches any new
 * `gql` literal added during or after the migration.
 *
 * Rollout: severity "warn" throughout the migration (50 existing hits
 * would make "error" immediately block the branch). Promotes to "error"
 * after the 50-site sweep closes.
 *
 * Refs:
 *  - docs/plans/2026-04-17-agentic-post-audit-consolidation-plan.md#Phase-2
 *  - docs/plans/2026-04-17-agentic-post-audit-consolidation-plan.md#Phase-8
 *  - .claude/agents-enterprise-v2/frontend-expert.md (GraphQL section)
 *  - https://the-guild.dev/graphql/codegen/plugins/typescript/typed-document-node
 */
import { ESLintUtils } from '@typescript-eslint/utils';
declare const _default: ESLintUtils.RuleModule<"bareGqlTag", [], ESLintUtils.RuleListener>;
export default _default;
//# sourceMappingURL=no-bare-graphql-query-string.d.ts.map