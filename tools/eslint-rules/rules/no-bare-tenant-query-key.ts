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

import { ESLintUtils, TSESTree } from '@typescript-eslint/utils';

type MessageIds = 'bareQueryKey' | 'tenantIdNotPrefix';
type Options = [];

const createRule = ESLintUtils.RuleCreator(
  (name) =>
    `https://github.com/Okan-wqm/aquaculture_platform/blob/main/tools/eslint-rules/rules/${name}.ts`,
);

/**
 * Identifier names in array elements that are a strong signal the key is
 * tenant-scoped (and therefore MUST use the factory).
 */
const TENANT_ID_HINTS = new Set(['tenantId', 'tenant_id', 'currentTenantId', 'activeTenantId']);

export default createRule<Options, MessageIds>({
  name: 'no-bare-tenant-query-key',
  meta: {
    type: 'problem',
    docs: {
      description:
        'queryKey for TanStack Query hooks must use createTenantQueryKey(tenantId, ...) from shared-ui (ADR-009). Bare arrays leak cache across tenant switches.',
    },
    schema: [],
    messages: {
      bareQueryKey:
        'queryKey must use createTenantQueryKey(tenantId, ...segments) from @aquaculture/shared-ui. Bare arrays cannot be purged on tenant switch and cause cross-tenant cache leak (FE-CRITICAL-001). Import: `import { createTenantQueryKey } from "@aquaculture/shared-ui";`. Replace `[\'x\', tenantId, filter]` with `createTenantQueryKey(tenantId, \'x\', filter)`.',
      tenantIdNotPrefix:
        'tenantId must be the FIRST parameter of createTenantQueryKey. Found array with tenantId in a non-prefix position — this is the exact FE-CRITICAL-001 bleed pattern. Migrate to `createTenantQueryKey(tenantId, ...)`.',
    },
  },
  defaultOptions: [],
  create(context) {
    function isTenantHintedArray(arr: TSESTree.ArrayExpression): boolean {
      // Check if any element references a tenant-id identifier.
      for (const el of arr.elements) {
        if (!el) continue;
        if (el.type === 'Identifier' && TENANT_ID_HINTS.has(el.name)) {
          return true;
        }
        if (el.type === 'MemberExpression' && el.property.type === 'Identifier') {
          if (TENANT_ID_HINTS.has(el.property.name)) {
            return true;
          }
        }
      }
      return false;
    }

    return {
      Property(node: TSESTree.Property) {
        // Find `queryKey: ...` inside an object expression.
        if (node.key.type !== 'Identifier' || node.key.name !== 'queryKey') return;

        const value = node.value;

        // Accept: createTenantQueryKey(...)  (CallExpression with matching callee)
        if (
          value.type === 'CallExpression' &&
          value.callee.type === 'Identifier' &&
          value.callee.name === 'createTenantQueryKey'
        ) {
          return;
        }

        // Flag: bare ArrayExpression
        if (value.type === 'ArrayExpression') {
          if (isTenantHintedArray(value)) {
            context.report({ node, messageId: 'tenantIdNotPrefix' });
          } else {
            context.report({ node, messageId: 'bareQueryKey' });
          }
          return;
        }

        // Flag: identifier / member expression that was produced by a local
        // variable — we cannot statically prove it goes through the factory.
        // Warn with the generic message; authors should inline the call.
        if (value.type === 'Identifier' || value.type === 'MemberExpression') {
          context.report({ node, messageId: 'bareQueryKey' });
        }
      },
    };
  },
});
