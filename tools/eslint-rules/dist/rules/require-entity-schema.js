"use strict";
/**
 * require-entity-schema — enforces ADR-011 schema ownership model.
 *
 * Every `@Entity(...)` decorator in `apps/**\/src\/**` MUST declare a
 * `schema:` option pointing at the service's owned schema. Failing to
 * do so defaults the table to PostgreSQL's `public` schema, which:
 *
 *   1. Breaks RLS bootstrap (the 2026-04-14 incident — see ADR-011).
 *   2. Bypasses the SchemaDriftValidator (ADR-012) at runtime.
 *   3. Silently mixes tenant / service data into the shared `public`
 *      namespace, violating the tenant-isolation invariant.
 *
 * W1 audit reconciled 157 violations across 10 services. This rule
 * catches new occurrences at lint time so the count does not grow
 * while the mechanical W2-W3 fix sweep is in flight.
 *
 * Invocation: @aquaculture/eslint-rules via the root `.eslintrc.json`
 * plugins array. Severity starts at "warn" for progressive rollout.
 *
 * Refs:
 *  - /root/.claude/plans/declarative-riding-shamir.md BLOCKER-8 + BLOCKER-20
 *  - /var/aqua-saas/docs/adr/011-schema-ownership-model.md
 *  - /var/aqua-saas/docs/adr/012-schema-drift-prevention.md
 *  - /var/aqua-saas/docs/reviews/_audit/2026-04-W16-anti-patterns.md
 */
Object.defineProperty(exports, "__esModule", { value: true });
const utils_1 = require("@typescript-eslint/utils");
const createRule = utils_1.ESLintUtils.RuleCreator((name) => `https://github.com/Okan-wqm/aquaculture_platform/blob/main/tools/eslint-rules/rules/${name}.ts`);
const DEFAULT_EXEMPT_PATTERNS = [
    '**/*.spec.ts',
    '**/__tests__/**',
    '**/*.entity.base.ts',
];
exports.default = createRule({
    name: 'require-entity-schema',
    meta: {
        type: 'problem',
        docs: {
            description: 'Every @Entity() decorator must declare a `schema:` option naming the owning service (ADR-011).',
        },
        schema: [
            {
                type: 'object',
                properties: {
                    exemptPatterns: {
                        type: 'array',
                        items: { type: 'string' },
                    },
                },
                additionalProperties: false,
            },
        ],
        messages: {
            missingSchemaOption: "@Entity() is missing the `schema:` option. ADR-011 requires every entity to declare its owning service schema, otherwise the table defaults to `public` and breaks RLS + SchemaDriftValidator. Example: `@Entity('users', { schema: 'auth' })`.",
            invalidSchemaOption: 'schema option must be a non-empty string literal naming the owning service schema (e.g. "farm", "sensor"). Dynamic or empty schema identifiers defeat the invariant.',
        },
    },
    defaultOptions: [{ exemptPatterns: DEFAULT_EXEMPT_PATTERNS }],
    create(context) {
        return {
            Decorator(node) {
                const expression = node.expression;
                if (expression.type !== 'CallExpression' ||
                    expression.callee.type !== 'Identifier' ||
                    expression.callee.name !== 'Entity') {
                    return;
                }
                // @Entity() with zero args  → flag
                // @Entity('table')          → flag (no schema)
                // @Entity({ name, schema }) → OK if schema present
                // @Entity('table', { schema }) → OK if schema present
                const args = expression.arguments;
                if (args.length === 0) {
                    context.report({ node, messageId: 'missingSchemaOption' });
                    return;
                }
                const firstArg = args[0];
                const secondArg = args[1];
                let optionsArg = null;
                if (args.length === 1 && firstArg && firstArg.type === 'ObjectExpression') {
                    optionsArg = firstArg;
                }
                else if (args.length >= 2 && secondArg && secondArg.type === 'ObjectExpression') {
                    optionsArg = secondArg;
                }
                if (!optionsArg) {
                    context.report({ node, messageId: 'missingSchemaOption' });
                    return;
                }
                const schemaProp = optionsArg.properties.find((p) => p.type === 'Property' &&
                    p.key.type === 'Identifier' &&
                    p.key.name === 'schema');
                if (!schemaProp) {
                    context.report({ node, messageId: 'missingSchemaOption' });
                    return;
                }
                if (schemaProp.value.type !== 'Literal' ||
                    typeof schemaProp.value.value !== 'string' ||
                    schemaProp.value.value.length === 0) {
                    context.report({
                        node: schemaProp,
                        messageId: 'invalidSchemaOption',
                    });
                }
            },
        };
    },
});
//# sourceMappingURL=require-entity-schema.js.map