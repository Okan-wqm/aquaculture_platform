"use strict";
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
 *  - .claude/agents/frontend-expert.md (GraphQL section)
 *  - https://the-guild.dev/graphql/codegen/plugins/typescript/typed-document-node
 */
Object.defineProperty(exports, "__esModule", { value: true });
const utils_1 = require("@typescript-eslint/utils");
const createRule = utils_1.ESLintUtils.RuleCreator((name) => `https://github.com/Okan-wqm/aquaculture_platform/blob/main/tools/eslint-rules/rules/${name}.ts`);
/**
 * Path substrings that indicate test / mock / generated contexts where
 * the rule does NOT apply. `generated/` is the codegen output directory
 * convention; those files legitimately host the DocumentNode source
 * literals that this rule is steering consumers toward.
 */
const EXEMPT_CONTEXT_PATTERNS = [
    /\.spec\.tsx?$/,
    /\.test\.tsx?$/,
    /\.e2e\.tsx?$/,
    /\/__tests__\//,
    /\/__mocks__\//,
    /\/generated\//,
];
function tagIdentifier(tag) {
    if (tag.type === 'Identifier')
        return tag.name;
    if (tag.type === 'MemberExpression' && tag.property.type === 'Identifier') {
        return tag.property.name;
    }
    return null;
}
exports.default = createRule({
    name: 'no-bare-graphql-query-string',
    meta: {
        type: 'problem',
        docs: {
            description: 'Raw `gql`...`` tagged templates bypass type-safe federated-schema contracts. Use TypedDocumentNode constants from graphql-codegen output (web/*/generated/graphql.ts).',
        },
        schema: [],
        messages: {
            bareGqlTag: 'Raw `gql`…`` tagged template produces an untyped DocumentNode — schema breaking changes surface only at runtime. Generate a TypedDocumentNode via graphql-codegen and import it from the generated/ directory. Reference: .claude/agents/frontend-expert.md (GraphQL section) + docs/plans/2026-04-17-agentic-post-audit-consolidation-plan.md#Phase-8 (the mass-migration sweep is in flight — new bare gql should NOT be added).',
        },
    },
    defaultOptions: [],
    create(context) {
        const filename = context.getFilename().replace(/\\/g, '/');
        if (EXEMPT_CONTEXT_PATTERNS.some((re) => re.test(filename)))
            return {};
        return {
            TaggedTemplateExpression(node) {
                const ident = tagIdentifier(node.tag);
                if (ident !== 'gql')
                    return;
                context.report({ node: node.tag, messageId: 'bareGqlTag' });
            },
        };
    },
});
//# sourceMappingURL=no-bare-graphql-query-string.js.map