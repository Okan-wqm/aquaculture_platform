# ADR-009: Frontend Data Fetch Pattern

**Date:** 2026-03-14
**Status:** Accepted
**Deciders:** Platform Team

---

## Context

The admin-panel frontend historically had 4 different data fetching patterns:

1. **Monolithic adminApi** -- single 2000+ line file with all API calls
2. **useAsyncData hook** -- generic hook with loading/error/retry states
3. **Direct fetch()** -- raw fetch calls scattered in components
4. **Mock data** -- hardcoded objects during prototyping

Sprint 1-3 fixes standardized this. The monolithic adminApi was decomposed (H9 fix) into 14 domain-specific modules (`api/tenants.ts`, `api/billing.ts`, etc.) re-exported through a barrel file. `useAsyncData` was hardened with LRU cache (H1), ref-stabilized callbacks (C8, PERF-001), timeout/abort support (BUG-012), and stale-closure prevention.

## Decision

**Single standard: decomposed adminApi + useAsyncData hook.**

1. All API calls go through domain-specific modules in `services/api/*.ts`
2. Pages consume data via `useAsyncData(() => tenantsApi.list())` pattern
3. Direct `fetch()` in components is prohibited
4. Mock data must be removed before merge
5. `http-client.ts` handles auth headers, base URL, retry logic, error normalization

## Consequences

**Positive:**
- Consistent loading/error/retry UX across all pages
- LRU cache (max 100 entries, 30s TTL) prevents redundant requests
- AbortController cleanup prevents state updates on unmounted components
- Domain-specific API modules are individually testable and tree-shakeable

**Negative:**
- Slight learning curve for new developers (must use useAsyncData, not raw fetch)
- Cache invalidation requires explicit `clearAsyncCache(key)` calls after mutations
