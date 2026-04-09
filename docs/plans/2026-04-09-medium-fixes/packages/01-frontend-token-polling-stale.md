# Package 01: frontend-token-polling-stale

## Metadata
Status: PENDING
Estimated Tokens: 18K
Priority: MEDIUM
Security-Sensitive: yes
Parallelizable: yes
Prerequisites: none

## Closing-Findings
Closing-Findings: [FE-MEDIUM-013, FE-MEDIUM-025, FE-MEDIUM-026, FE-MEDIUM-030, FE-MEDIUM-032, FE-MEDIUM-037]

## Source-Reviews
- docs/reviews/orchestrator/2026-04-09-full-platform-audit.md
- docs/reviews/context-manager/2026-04-09-tier1-compaction.md

## Context
Six frontend findings share a root cause: the shell and farm-module use manual polling, flat staleTime, and ad-hoc reconnection logic instead of leveraging TanStack Query's built-in refetch lifecycle and proper resource-scoped deduplication. Fixing them together is atomic because they touch the same hook/provider layer and share a single test surface.

## Findings

**FE-MEDIUM-013 — No visibilitychange token refresh**
The shell auth provider does not listen to the `visibilitychange` event. When a user switches tabs and returns after the access token expires, API calls fail with 401 until the next polling interval fires. The token refresh should trigger immediately on tab re-focus.

**FE-MEDIUM-025 — Manual polling instead of TanStack Query refetchOnWindowFocus**
Multiple hooks use `setInterval` polling instead of TanStack Query's `refetchOnWindowFocus` and `refetchOnReconnect` options. This wastes bandwidth on backgrounded tabs and misses the instant-refetch on foreground.

**FE-MEDIUM-026 — Flat 5min staleTime across all queries**
A global `staleTime: 300_000` is applied to all queries. Real-time data (sensor readings, batch status) needs sub-30s staleTime; reference data (species list, farm config) can tolerate 10min+. A per-domain staleTime strategy is needed.

**FE-MEDIUM-030 — Offline mutation dedup lacks resourceId**
The offline queue deduplicates mutations by `mutationKey` alone, which is the hook name. Two offline edits to different batches (same hook, different resource) collide — the second overwrites the first. Add `resourceId` to the dedup key.

**FE-MEDIUM-032 — Socket reconnects on every token change**
`useFarmRealtimeStream` destroys and recreates the Socket.IO connection on every token refresh (every 4 min). The socket should update its `auth.token` in-place and only reconnect if the socket is actually disconnected.

**FE-MEDIUM-037 — Farm module CORS set to true**
`web/modules/farm-module/vite.config.ts` has `cors: true` in the dev server config, which reflects `Access-Control-Allow-Origin: *`. This should be scoped to the shell origin.

## Affected Files
- web/shell/src/providers/AuthProvider.tsx
- web/shell/src/providers/QueryProvider.tsx (or equivalent TanStack config)
- web/modules/farm-module/src/hooks/useFarmRealtimeStream.ts
- web/modules/farm-module/vite.config.ts
- web/shared-ui/src/hooks/useOfflineMutationQueue.ts (or equivalent offline queue hook)

## Dependencies
None. Frontend-only changes, no backend prerequisite.

## Atomic Commit Plan
```
fix(frontend): add visibilitychange refresh, per-domain staleTime, socket token update, offline resourceId dedup

Replace manual setInterval polling with TanStack refetchOnWindowFocus/refetchOnReconnect.
Introduce per-domain staleTime config (30s real-time, 600s reference).
Add visibilitychange listener to AuthProvider for immediate token refresh on tab focus.
Update useFarmRealtimeStream to patch socket.auth.token in-place instead of full reconnect.
Add resourceId to offline mutation dedup key.
Scope farm-module dev CORS to shell origin.

Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#FE-MEDIUM-013
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#FE-MEDIUM-025
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#FE-MEDIUM-026
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#FE-MEDIUM-030
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#FE-MEDIUM-032
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#FE-MEDIUM-037
Plan: docs/plans/2026-04-09-medium-fixes/packages/01-frontend-token-polling-stale.md
```

## Test Plan
- Unit test: AuthProvider fires token refresh on visibilitychange
- Unit test: useFarmRealtimeStream updates auth.token without socket disconnect
- Unit test: offline queue dedup key includes resourceId — two mutations on different resources both survive
- Verify staleTime per query key prefix via TanStack QueryClient inspection
- Manual smoke: open farm module in two tabs, switch between them, verify no 401 burst

## Verification Command
`npx tsc --noEmit -p web/modules/farm-module/tsconfig.json && npx vitest run web/modules/farm-module && npx vitest run web/shell`

## Rollback Plan
`git revert {placeholder_for_commit_hash} --no-edit`

## Failure Notes
