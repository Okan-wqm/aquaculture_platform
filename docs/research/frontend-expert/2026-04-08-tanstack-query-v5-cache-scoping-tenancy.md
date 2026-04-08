# Research: TanStack Query v5 Cache Scoping and Multi-Tenant Isolation
**Topic:** staleTime/gcTime tuning per query type, tenant-scoped query keys, cache invalidation on tenant switch, cross-tenant data leak prevention via shared caches
**Date:** 2026-04-08
**Agent:** frontend-expert

## Sources
- [TanStack Query v5 — QueryClient reference](https://tanstack.com/query/v5/docs/reference/QueryClient)
- [TanStack Query v5 — QueryCache reference](https://tanstack.com/query/v5/docs/reference/QueryCache)
- [TanStack Query v5 — Query Invalidation guide](https://tanstack.com/query/v5/docs/framework/react/guides/query-invalidation)
- [TanStack Query v5 — Caching examples](https://tanstack.com/query/v5/docs/react/guides/caching)
- [TanStack Query v5 — Important Defaults](https://tanstack.com/query/v5/docs/react/guides/important-defaults)
- [TanStack Query v5 — Migrating to v5](https://tanstack.com/query/v5/docs/react/guides/migrating-to-v5)
- [TanStack Query v5 — useQuery reference](https://tanstack.com/query/v5/docs/framework/react/reference/useQuery)
- [TanStack Query v5 — persistQueryClient plugin](https://tanstack.com/query/v5/docs/react/plugins/persistQueryClient)
- [TanStack blog — Announcing v5](https://tanstack.com/blog/announcing-tanstack-query-v5)
- [TanStack/query Discussion #1886 — Reset User Data on Logout](https://github.com/TanStack/query/discussions/1886)
- [TanStack/query Discussion #3280 — How to clear the entire cache storage](https://github.com/TanStack/query/discussions/3280)
- [TanStack/query Discussion #7839 — Handle logout and user-dependent queries](https://github.com/TanStack/query/discussions/7839)
- [TanStack/query Discussion #5867 — persisting the cache misunderstanding](https://github.com/TanStack/query/discussions/5867)

## Key Findings

### 1. v5 terminology: `gcTime` replaces `cacheTime`
In v5, the "cacheTime" option was renamed `gcTime` (garbage collection time). Semantics unchanged: it's the time an unused query is kept in memory before being collected. `staleTime` is the time a query result is considered fresh (no refetch needed). Defaults:
- `staleTime: 0` — every mount triggers a refetch (aggressive).
- `gcTime: 5 * 60 * 1000` — 5 minutes.

For an aquaculture SaaS, these defaults are wrong. A tuned matrix:

| Query type | staleTime | gcTime | Rationale |
|---|---|---|---|
| User/session/tenant metadata | `Infinity` (invalidate explicitly on change) | `1h` | Changes rarely, critical correctness. |
| Org chart, roles, permissions | `10 min` | `1h` | Low change frequency. |
| Batch list, farm list | `1 min` | `10 min` | Moderate change. |
| Sensor readings (live) | `10 sec` | `2 min` | High change, polling pattern. |
| Aggregated KPIs/charts | `2 min` | `30 min` | Dashboard context, periodic refresh. |
| Static reference data (species, units) | `Infinity` | `24h` | Never changes mid-session. |
| Search results | `30 sec` | `5 min` | User-driven. |

Rule: the tighter the operational loop, the lower the staleTime — sensor data must refetch aggressively.

### 2. Tenant-scoped query keys are MANDATORY
Any query that returns tenant-specific data MUST include the tenant ID as the **first segment** of the query key:
```ts
['tenant', tenantId, 'batch', batchId]
// NOT ['batch', batchId]
```
Why first segment?
- `invalidateQueries({ queryKey: ['tenant', oldTenantId] })` uses prefix matching — invalidating a tenant atomically becomes a one-liner.
- Debugging: grepping for `['tenant', ...]` shows every tenant-bound query instantly.
- Type enforcement: a `tenantQueryKey<T>` helper can require the tenant ID at compile time.

**Without tenant-scoped keys, this bug is inevitable:** User switches from Tenant A to Tenant B. A query with key `['batch', 123]` is reused across both tenants because the key has no tenant discriminator. User sees Tenant A's batch 123 data while operating as Tenant B — CRITICAL cross-tenant data leak.

### 3. Tenant switch: `queryClient.clear()` + atomic context swap
The safest tenant-switch flow:
1. Mark auth state as transitioning (block UI).
2. `queryClient.cancelQueries()` — cancel every in-flight request.
3. `queryClient.clear()` — drop all cached data.
4. Swap tenant context atomically.
5. Resume UI.

Partial approaches are dangerous:
- Using `invalidateQueries` alone leaves stale data visible until refetch completes.
- Using `removeQueries` alone doesn't cancel in-flight requests, so the old tenant's response arrives after the swap.
- Relying on `gcTime` to eventually drop old data creates a long cross-tenant visibility window.

### 4. `persistQueryClient` is dangerous in multi-tenant
`persistQueryClient` serializes the cache to storage (localStorage or IndexedDB) and hydrates on app load. Known issues for multi-tenant:
- On logout/login-as-different-tenant, the persisted cache may hydrate BEFORE the new tenant's auth is validated, showing previous tenant's data in the UI for seconds.
- On logout, calling `queryClient.clear()` DOES clear the in-memory state but may lag the persister (per TanStack discussion #3280, needs explicit `persister.removeClient()` call, not fire-and-forget).
- Storage quotas: persisted caches for long sessions can exceed IndexedDB quota.

Recommendation:
- Use `persistQueryClient` ONLY for queries explicitly marked safe (via a `meta: { persist: true }` filter).
- Exclude tenant-scoped queries from persistence unless the persister is tenant-keyed (separate storage key per tenant).
- On logout, call `persister.removeClient()` and AWAIT it before the subsequent login flow.

### 5. MFE + multi-QueryClient isolation pattern
TanStack v5 supports passing a custom `queryClient` directly to hooks, bypassing the React context. This is the official MFE isolation story — but in aqua-saas's shared singleton model, the shell's queryClient IS shared across remotes, so isolation must be logical (tenant-scoped keys) rather than physical (multiple clients).

If an MFE needs stricter isolation (e.g. a sandbox feature that must not share cache), use a local `queryClient` passed to that remote's hooks explicitly.

### 6. Mutation cache-invalidation pattern
On a successful mutation that affects tenant data, invalidate with the narrowest precise key, falling back to broader prefixes only when needed:
```ts
await queryClient.invalidateQueries({ queryKey: ['tenant', tenantId, 'batch', batchId] });
```
NEVER use `invalidateQueries()` with no key (invalidates everything) in production — it causes a refetch storm. Invalidate surgically.

### 7. `networkMode` and offline considerations
v5 introduced `networkMode: 'online' | 'always' | 'offlineFirst'`. For the AquaMobil PWA, `offlineFirst` is appropriate: queries run against cache first and network second. The shell (desktop) should use `online` (default) — query only runs if network is available.

## Security Concerns

1. **CRITICAL — Query keys without tenant ID.** Guaranteed cross-tenant data leak on tenant switch.
2. **CRITICAL — Logout that doesn't call `queryClient.clear()`.** Previous user's data visible to next user on shared device.
3. **CRITICAL — `persistQueryClient` without tenant-keyed storage.** Persisted cache from tenant A shown to tenant B.
4. **HIGH — Tenant switch without `cancelQueries`.** In-flight old-tenant requests arrive post-swap and populate cache with wrong-tenant data.
5. **HIGH — `persister.removeClient()` not awaited on logout.** Race window where persisted cache survives the clear.
6. **HIGH — `invalidateQueries()` with no key in production.** Refetch storm = effective DoS on backend.
7. **MEDIUM — `staleTime: Infinity` on a query that should invalidate on external changes.** Stale data displayed indefinitely.
8. **MEDIUM — `gcTime` too long for sensitive data.** Data lingers in memory longer than needed.

## Performance Concerns

1. **Default `staleTime: 0`** causes refetch on every mount. Tune per query type.
2. **Polling queries** should use `refetchInterval`, NOT `useEffect` + `setInterval`.
3. **Mass invalidation** causes refetch storms — invalidate surgically.
4. **`persistQueryClient` serialization on every cache change** has a cost — throttle or limit to explicit persistable queries.
5. **Query deduplication is automatic** in TanStack Query — don't wrap `useQuery` calls with custom dedup.

## Architectural Implications for frontend-expert reviews

When reviewing any `useQuery`, `useMutation`, query key factory, or tenant switch code:
1. Verify every tenant-scoped query key starts with `['tenant', tenantId, ...]`.
2. Verify a central `queryKeys.ts` factory exists and is used — no inline `queryKey: ['batch', id]` strings.
3. Verify tenant switch flow: `cancelQueries` → `clear` → swap context → resume.
4. Verify logout calls `queryClient.clear()` synchronously before navigation.
5. If `persistQueryClient` is used: verify it's tenant-keyed OR filters tenant-scoped queries out; verify `persister.removeClient()` is awaited on logout.
6. Verify `staleTime` and `gcTime` are set per query type, not defaulted.
7. Flag `staleTime: Infinity` unless paired with explicit invalidation on mutation.
8. Flag `invalidateQueries()` with no key argument as HIGH in any production code path.
9. Verify polling uses `refetchInterval`, not `useEffect` + `setInterval`.
10. Verify no `useEffect` for data fetching anywhere — always TanStack Query hooks.
11. Verify mutation `onSuccess` uses precise `invalidateQueries` with the narrowest key.
12. Verify AquaMobil PWA uses `networkMode: 'offlineFirst'`; shell uses default `'online'`.
13. Verify MFE remotes import and use the shared queryClient (singleton) — local query clients only for sandbox features.

## Domain Rule Additions for frontend-expert

### Multi-Tenancy — additions
- **MUST** prefix every tenant-scoped query key with `['tenant', tenantId, ...]`. Non-prefixed = CRITICAL (cross-tenant leak).
- **MUST** centralize query keys in a typed factory (`queryKeys.ts`). Inline keys = HIGH.
- **MUST** on tenant switch: `cancelQueries` → `clear` → swap context → resume. Partial approach = CRITICAL.
- **MUST** on logout: synchronously `queryClient.clear()` before navigation. Async fire-and-forget = HIGH.
- **MUST** if using `persistQueryClient`: tenant-key the storage AND await `persister.removeClient()` on logout. Missing = CRITICAL.
- **MUST** exclude tenant-sensitive queries from persistence via `meta: { persist: false }` filter unless tenant-keyed.

### Performance — TanStack Query additions
- **MUST** set `staleTime` and `gcTime` explicitly per query type; default `staleTime: 0` in production = MEDIUM.
- **MUST NOT** use `invalidateQueries()` with no key in production. Refetch storm = HIGH.
- **MUST** use `refetchInterval` for polling, not `useEffect + setInterval`. Custom polling = MEDIUM.
- **MUST NOT** use `useEffect` for data fetching anywhere. Ad-hoc fetch = HIGH.
- **MUST** invalidate with the narrowest precise query key on mutation success. Broad invalidation = MEDIUM.
- **MUST** use `networkMode: 'offlineFirst'` for AquaMobil PWA; default for desktop shell.
