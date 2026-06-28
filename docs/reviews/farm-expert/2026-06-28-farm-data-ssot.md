# Farm Data SSOT & Tenant Read Boundary — 2026-06-28

Review cycle backing the Farm Data SSOT remediation (plan: `farm-data-ssot-sequential-sifakis`).
Validated against the codebase with adversarial multi-agent review; the "data
appears/disappears" symptom traces to a fail-open tenant read path, mock data in
production report tabs, and farm-module operating off the GraphQL contract SSOT.

## FARM-HIGH-060 — Tenant DB boundary does not set/assert the RLS GUC or resolved schema

`runInTenantRead` / `runInTenantTransaction` pinned `search_path` transaction-locally
but never set or verified `app.current_tenant` and never read back `current_schema()`.
The RLS GUC is set only on pool checkout (`rls-connection-bootstrap.service.ts`), so a
lost tenant context (unset GUC → RLS denies all rows) or a missing tenant schema
(search_path silently falls back to the `farm` source schema) produced an empty result
indistinguishable from a legitimately-empty table — the platform's "data disappears"
failure mode.

Evidence:
- `libs/backend-common/src/database/tenant-transaction.ts:93`
- `libs/backend-common/src/database/rls/rls-connection-bootstrap.service.ts:94`
- `apps/farm-service/src/site/handlers/get-site.handler.ts:26`

Fix: the boundary now owns `app.current_tenant` transaction-locally and asserts
`current_schema()` + the GUC against the expected `tenant_<uuid>` before any domain
query runs, throwing a typed `TenantContextError` (`SCHEMA_MISMATCH` / `RLS_MISMATCH`)
instead of returning a silent empty result. See `tenant-transaction.ts` +
`tenant-context-error.ts`.

## Related (tracked separately in the plan)

- FARM-CRITICAL-* umbrella: 139/169 farm handlers read via raw `@InjectRepository`
  (0 use `runInTenantRead`); reads must migrate onto the asserting boundary and the
  error-masking `null`/`[]` blocks (`get-site`, `get-department`, `system.resolver`,
  `farm.resolver`) removed.
- Production mock data in routed report tabs (`reports/tabs/*Tab.tsx`).
- farm-module off the GraphQL codegen SSOT (raw `graphqlClient.request<...>` generics).
