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
import { ESLintUtils } from '@typescript-eslint/utils';
type MessageIds = 'missingSchemaOption' | 'invalidSchemaOption';
type Options = [
    {
        /**
         * File-path globs where this rule does NOT apply. Boundary
         * allowlist entries live in `.claude/allowlists/boundary-files.yaml`
         * but the rule itself also supports per-repo exemptions here for
         * files that are not entities (e.g., base-class mixins).
         */
        exemptPatterns?: string[];
    }
];
declare const _default: ESLintUtils.RuleModule<MessageIds, Options, unknown, ESLintUtils.RuleListener> & {
    name: string;
};
export default _default;
//# sourceMappingURL=require-entity-schema.d.ts.map