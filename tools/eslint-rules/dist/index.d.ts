/**
 * @aquaculture/eslint-rules — custom lint rules
 *
 * Entry point exports a `rules` object consumed by ESLint when this
 * package is loaded via the `plugins: ["aquaculture"]` directive in
 * the root `.eslintrc.json`.
 *
 * Each rule encodes a specific architectural invariant from CLAUDE.md
 * or a canonical ADR. Rules start at `severity: "warn"` for 30 days
 * per the progressive-rollout protocol (plan v4 D.5) and promote to
 * `error` only after the calibration window confirms low false-positive
 * rate.
 *
 * See `/root/.claude/plans/declarative-riding-shamir.md` BLOCKER-20.
 */
export declare const rules: {
    'require-entity-schema': import("@typescript-eslint/utils/ts-eslint").RuleModule<"missingSchemaOption" | "invalidSchemaOption", [{
        exemptPatterns?: string[];
    }], unknown, import("@typescript-eslint/utils/ts-eslint").RuleListener> & {
        name: string;
    };
    'no-bare-tenant-query-key': import("@typescript-eslint/utils/ts-eslint").RuleModule<"bareQueryKey" | "tenantIdNotPrefix", [], unknown, import("@typescript-eslint/utils/ts-eslint").RuleListener> & {
        name: string;
    };
    'no-direct-event-publish': import("@typescript-eslint/utils/ts-eslint").RuleModule<"directEventBusPublish" | "directNatsClientPublish", [], unknown, import("@typescript-eslint/utils/ts-eslint").RuleListener> & {
        name: string;
    };
    'no-high-cardinality-metric-label': import("@typescript-eslint/utils/ts-eslint").RuleModule<"unboundedCardinalityLabel", [], unknown, import("@typescript-eslint/utils/ts-eslint").RuleListener> & {
        name: string;
    };
    'no-claude-sdk-raw-call': import("@typescript-eslint/utils/ts-eslint").RuleModule<"rawAnthropicImport", [], unknown, import("@typescript-eslint/utils/ts-eslint").RuleListener> & {
        name: string;
    };
    'no-bare-graphql-query-string': import("@typescript-eslint/utils/ts-eslint").RuleModule<"bareGqlTag", [], unknown, import("@typescript-eslint/utils/ts-eslint").RuleListener> & {
        name: string;
    };
    'no-unpinned-ssrf-fetch': import("@typescript-eslint/utils/ts-eslint").RuleModule<"bareFetchInSensitiveZone" | "removedGetSafeFetchOptions", [], unknown, import("@typescript-eslint/utils/ts-eslint").RuleListener> & {
        name: string;
    };
    'no-unsandboxed-html-frame': import("@typescript-eslint/utils/ts-eslint").RuleModule<"frameWithoutSandbox" | "srcDocOutsideSandboxedPreview", [], unknown, import("@typescript-eslint/utils/ts-eslint").RuleListener> & {
        name: string;
    };
};
//# sourceMappingURL=index.d.ts.map