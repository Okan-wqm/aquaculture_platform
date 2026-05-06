/**
 * no-bare-tenant-query-key — enforces ADR-009 tenant-scoped query key discipline.
 *
 * Every `queryKey: [...]` in TanStack Query v5 hooks (useQuery, useMutation,
 * useInfiniteQuery, queryClient.{get,set,invalidate,remove,prefetch,fetch}Queries)
 * MUST be wrapped with `createTenantQueryKey(tenantId, ...segments)` from
 * `@aquaculture/shared-ui`. Bare arrays (e.g., `['healthEvents', tenantId, ...]`)
 * do NOT put `tenantId` in a fixed position prefix — after tenant switch
 * `queryClient.removeQueries({ queryKey: ['tenant', prevTenantId] })` does NOT
 * match, and the previous tenant's cache stays addressable. This is the
 * cross-tenant cache-leak vector FE-CRITICAL-001.
 *
 * Allowed forms:
 *   queryKey: createTenantQueryKey(tenantId, 'healthEvents', filter)
 *   queryKey: ['public', 'tenants']    // non-tenant-scoped data (opt-in exemption)
 *
 * Violating forms (FE-CRITICAL-001 class):
 *   queryKey: ['healthEvents', tenantId, filter]  // tenantId not prefix
 *   queryKey: ['users']                           // tenant-scoped but unscoped
 *
 * Exemption: a line-level `// eslint-disable-next-line aquaculture/no-bare-tenant-query-key`
 * comment is accepted when the queried resource is GENUINELY tenant-agnostic
 * (platform-wide lookups, auth-service /health, public config). Overuse of the
 * exemption is itself a MEDIUM finding (root-cause-auditor Phase 4.5 sweep).
 *
 * Rollout: severity starts at "warn" per progressive-rollout protocol.
 * Promotes to "error" after 420+ existing call sites migrate via Phase 8.4
 * mass migration (tracked as FE-CRITICAL-001 open finding).
 *
 * Refs:
 *  - /root/.claude/plans/abstract-brewing-mochi.md#Phase-8.4
 *  - /var/aqua-saas/docs/adr/009-frontend-data-fetch-pattern.md
 *  - /var/aqua-saas/.claude/knowledge/layer-1-react.md (createTenantQueryKey section)
 *  - /var/aqua-saas/web/shared-ui/src/utils/tenant-query-keys.ts (the SSoT factory)
 */
import { ESLintUtils } from '@typescript-eslint/utils';
type MessageIds = 'bareQueryKey' | 'tenantIdNotPrefix';
declare const _default: ESLintUtils.RuleModule<MessageIds, [], unknown, ESLintUtils.RuleListener> & {
    name: string;
};
export default _default;
//# sourceMappingURL=no-bare-tenant-query-key.d.ts.map