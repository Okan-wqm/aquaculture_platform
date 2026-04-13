# Realtime Sync Auditor
Topic: `2026-04-13-full-platform-e2e`

Scope: `web/**`, `apps/**`, `web/apps/aquamobil/**` -- polling, SSE, WebSocket, notifications, sync status, job progress, live dashboards, and post-write convergence across the full platform.

## Prior Cycle Status

| Prior Finding | Status | Evidence |
|---|---|---|
| HIGH-001 (notification fallback poll) | OPEN | `web/apps/aquamobil/src/hooks/useNotifications.ts:96` still only polls `fetchUnreadCount()`, never the full list. Structurally unchanged. |
| HIGH-002 (offline queue auto-sync latch) | OPEN | `web/apps/aquamobil/src/hooks/useOfflineQueue.tsx:332` still gates on `result.success > 0`. Partial fix (BUG-17 retry interval at line 390) addresses retryable failures but not the zero-success latch. |
| HIGH-003 (tenant-admin cache keys) | RESOLVED | Commit `79ce984f` added `tenantId` to `useTenantActivity` keys (line 66: `['tenant-activity', tenantId]`) and `useDevicePolling` keys (line 124: `['edgeDevice', tenantId, deviceId]`). Verified in source. |

## Surfaces Audited

| # | Surface | Type | Source of Truth | Refresh Mechanism |
|---|---|---|---|---|
| S1 | Sensor readings (SCADA/dashboard) | WebSocket | sensor-service DB | Socket.IO `/sensors` namespace via `useSensorSocket`, `useEdgeIoSocket`, `useScadaLiveData` |
| S2 | Farm domain events | WebSocket | farm-service DB | Socket.IO `/farms` namespace via `useFarmRealtimeStream` |
| S3 | Messaging (chat) | WebSocket | messaging-service DB | Socket.IO `/messaging` namespace via `useMessageSocket` |
| S4 | AquaMobil notifications | Push + Poll | notification-service DB | FCM push + 5-min unread-count poll via `useNotifications` |
| S5 | Shell notifications | Poll | notification-service DB | 60-second unread-count poll via `useNotifications` |
| S6 | Tenant-admin activity | Poll | admin-api-service DB | TanStack Query 2-min `refetchInterval` via `useTenantActivity` |
| S7 | Edge device detail | Poll | gateway-api GraphQL | TanStack Query 5s poll (exponential backoff) via `useDevicePolling` |
| S8 | Alerts page | Poll | alert-engine DB | Manual `setInterval` 30-second poll via `useAlerts` |
| S9 | AquaMobil offline queue | Background sync | gateway-api GraphQL | Reconnect auto-sync + 30s retry via `useOfflineQueue` |
| S10 | AI chat SSE | SSE | ai-service agent | POST-based SSE stream via `ChatController` |
| S11 | LiveSensorWidget (dashboard) | Poll | sensor-service DB | TanStack Query 15s `refetchInterval` |
| S12 | Daily feeding executions | Poll | farm-service DB | TanStack Query 30s `refetchInterval` via `useDailyFeedingExecution` |
| S13 | Widget data (SCADA dashboard) | WS + Poll | sensor-service DB | WebSocket live + 60s history poll via `useWidgetData` |
| S14 | Sensor readings (SCADA process view) | Poll | sensor-service DB | Manual `setInterval` (configurable, default 10s) via `useSensorReadings` |
| S15 | ST Language service | WebSocket | gateway-api ST gateway | Dedicated WS via `stWebSocketService` |
| S16 | Tenant-admin data (stats, modules, users, devices, threads, tickets, announcements) | Poll / on-demand | admin-api-service DB | TanStack Query stale-while-revalidate via `useTenantData` |
| S17 | ConnectionStatusBanner (SCADA) | Derived | Socket.IO connection state | 30s stale detection interval |

## Findings

### CRITICAL-001 Sensor module Zustand stores are global singletons with no tenant isolation

- **Surface:** S1, S13, S14
- **Evidence:** `/var/aqua-saas/web/modules/sensor-module/src/hooks/useSensorSocket.ts:38` creates a module-scoped `useSensorStore` via `create<SensorSocketState>()`. This store's `lastReading` map (line 29) accumulates sensor readings keyed by `sensorId` only -- no tenant partitioning. Similarly, `/var/aqua-saas/web/modules/sensor-module/src/hooks/useEdgeIoSocket.ts:62` creates `useEdgeIoStore` with `devices` and `alarms` maps keyed by `deviceCode` only.
- **Evidence:** `/var/aqua-saas/web/modules/sensor-module/src/hooks/socketFactory.ts:19` maintains a module-level `pool` (Map of URL to Socket instance). The socket is shared across all hook consumers. When a tenant switch occurs, the pool is not drained, the Zustand stores are not cleared, and the underlying socket still carries the previous tenant's JWT until re-auth or reconnection happens.
- **Root cause:** The Zustand stores are architected as global singletons (correct for performance within a single tenant session) but have no lifecycle hook for tenant identity changes. The socket factory uses URL-keyed pooling with no tenant dimension. On a tenant switch, the backend will enforce isolation (new JWT, new room membership), but the client-side stores retain prior-tenant sensor readings and alarms until overwritten by new data arriving on matching `sensorId`/`deviceCode` keys.
- **Impact:** In admin impersonation or multi-tenant flows, a tenant switch can momentarily display the previous tenant's SCADA sensor readings, I/O tag values, and alarm states in the dashboard until new data arrives on the WebSocket. If both tenants happen to share deviceCodes (e.g., `EDGE-001`), the data can persist indefinitely.
- **Cross-domain dependency:** Send tenant isolation aspect to `tenant-isolation-auditor`.

### HIGH-001 AquaMobil notification fallback poll only refreshes badge, not list (OPEN from prior cycle)

- **Surface:** S4
- **Evidence:** `/var/aqua-saas/web/apps/aquamobil/src/hooks/useNotifications.ts:96-98` -- the `setInterval` only calls `fetchUnreadCount()`, never `fetchNotifications()`. The full notification list is only refreshed on initial mount (line 94) or via FCM push event (line 110-118).
- **Root cause:** Unchanged from prior cycle. The fallback polling path was deliberately reduced to badge-only in D07 PERF-01 to reduce network traffic, but no compensating mechanism exists for the notification list when FCM is unavailable (permission denied, background mode, iOS web push limitations).
- **Impact:** When FCM push is unavailable, the notification page can show a stale list indefinitely while the badge counter is current. Users see a badge number that doesn't match the list content.
- **Escalation:** This is the second consecutive cycle. Recommend systemic resolution: either poll the full list at a reduced rate (e.g., 5 minutes) or add a "pull to refresh" + visibility-change refetch for the list.
- **Cross-domain dependency:** Send list freshness to `list-visibility-auditor`.

### HIGH-002 Offline queue auto-sync still latches on zero-success runs (OPEN from prior cycle)

- **Surface:** S9
- **Evidence:** `/var/aqua-saas/web/apps/aquamobil/src/hooks/useOfflineQueue.tsx:332-334` -- `hasSyncedOnReconnectRef.current = false` is only executed when `result.success > 0`. The auto-sync trigger at line 369 sets `hasSyncedOnReconnectRef.current = true` before invoking sync. If the sync returns `{ success: 0, failed: N }` (all items fail), the guard remains set and no future auto-sync triggers until the user goes offline and comes back online.
- **Mitigating factor:** The BUG-17 periodic retry (lines 390-408) now retries retryable failures every 30 seconds. This reduces the practical impact for transient failures but does not address the architectural latch: new operations queued after a zero-success run while still online will not auto-sync.
- **Root cause:** Unchanged from prior cycle. The reconnect guard models "has synced" as a sticky latch instead of "has pending work."
- **Impact:** After a failed sync batch, new offline-queued operations accumulate silently without auto-sync until manual intervention or another offline/online cycle.
- **Cross-domain dependency:** Send mobile sync convergence to `mobile-app-auditor`.

### HIGH-004 Tenant-admin data query keys (`useTenantData`) are not tenant-scoped

- **Surface:** S16
- **Evidence:** `/var/aqua-saas/web/modules/tenant-admin/src/hooks/useTenantData.ts:85-117` defines `tenantKeys.all` as `['tenant']` with no `tenantId` segment. Every query key derived from this root -- `['tenant', 'info']`, `['tenant', 'stats']`, `['tenant', 'modules']`, `['tenant', 'users', ...]`, `['tenant', 'devices', ...]`, `['tenant', 'threads']`, `['tenant', 'tickets']`, `['tenant', 'announcements']`, `['tenant', 'notifPrefs']`, `['tenant', 'mobileUsersSettings']`, etc. -- is globally shared with no tenant partitioning.
- **Evidence:** While `useTenantActivity` (line 66) and `useDevicePolling` (line 124) were fixed in commit `79ce984f` to include `tenantId`, the remaining 20+ query keys in `useTenantData.ts` were NOT updated.
- **Root cause:** The `tenantKeys` factory was designed before the multi-tenant cache isolation requirement was identified. The commit `79ce984f` fixed the two hooks that had their own key factories but missed the shared `tenantKeys` factory that drives the majority of tenant-admin queries.
- **Impact:** In tenant-switch or impersonation scenarios, all tenant-admin surfaces (tenant info, stats, module list, user list, device list, messaging threads, support tickets, announcements, notification preferences, mobile user settings) will serve stale prior-tenant data from the React Query cache until the staleTime expires or a manual invalidation occurs. For `useMyTenant()` and `useTenantModules()` with 5-minute staleTime, this is a 5-minute window of cross-tenant data exposure.
- **Cross-domain dependency:** Send isolation aspect to `tenant-isolation-auditor`.

### HIGH-005 Alert history polling has no tenant scope and no convergence guarantee after error

- **Surface:** S8
- **Evidence:** `/var/aqua-saas/web/modules/sensor-module/src/hooks/useAlerts.ts:120-200` uses manual `useState` + `setInterval` (not React Query). There is no tenant ID in any state key or dependency. The hook's state (`alerts`, `loading`, `error`, `filters`) is local to the component instance but has no relationship to the active tenant.
- **Evidence:** The polling at line 191 calls `fetchAlerts(true)` every 30 seconds unconditionally. If a fetch fails (`setError` at line 179), the next poll silently replaces the error with new data or re-triggers the error. There is no backoff on repeated failures -- the hook continues polling at 30s indefinitely.
- **Root cause:** The hook predates the platform's tenant-scoped caching pattern. It uses `graphqlFetch` which reads the current tenant header at call time (so the backend is correct), but if a tenant switch occurs mid-session, the stale prior-tenant alerts remain in component state until the next successful fetch overwrites them.
- **Impact:** On tenant switch, up to 30 seconds of prior-tenant alert data can display. On persistent backend failures, the poll hammers the server at 30s intervals without backoff.
- **Cross-domain dependency:** Send tenant isolation to `tenant-isolation-auditor`.

### MEDIUM-001 Shell desktop notifications poll badge only, never the list

- **Surface:** S5
- **Evidence:** `/var/aqua-saas/web/shell/src/hooks/useNotifications.ts:172-186` -- the `useEffect` only calls `fetchUnreadCount()` on mount and polls it every 60 seconds. The full notification list is NEVER auto-fetched; `fetchNotifications` (line 103) is exposed but only called when `refetch()` is invoked (presumably by opening the notification panel).
- **Root cause:** The shell notification hook was designed for lazy-load: the badge polls cheaply, the list loads on demand. But if the user has the notification panel open and does not close/reopen it, the displayed list can diverge from the badge count.
- **Impact:** Minor UX inconsistency -- the badge count can increment while the displayed list remains static until the user triggers a manual refetch by re-opening the panel.

### MEDIUM-002 AI chat SSE endpoint sends all tool call results before the final message, no incremental streaming

- **Surface:** S10
- **Evidence:** `/var/aqua-saas/apps/ai-service/src/chat/chat.controller.ts:100-145` -- the handler calls `this.agentRunner.chat(chatRequest)` which blocks until the full agent run completes (line 114: `const result = await ...`). Only then does it emit tool_call, tool_result, and message events sequentially. Despite using SSE headers (line 93-98), the connection is inert (no data) until the entire agent execution finishes.
- **Root cause:** The `agentRunner.chat()` API is request-response, not streaming. The SSE wrapper provides incremental delivery of the result structure (tool calls, then message) but the user sees no progress indicator during the potentially long agent execution phase.
- **Impact:** For complex agent queries with multiple tool calls, the user sees a "loading" state with no progress for the entire agent execution duration. The SSE `start` event is emitted immediately, but no subsequent events arrive until the agent is done. This creates a "never-ending progress" appearance when the agent run takes >5 seconds.

### MEDIUM-003 `useSensorReadings` (SCADA process view) uses manual setInterval without backoff or error handling

- **Surface:** S14
- **Evidence:** `/var/aqua-saas/web/modules/sensor-module/src/hooks/useSensorReadings.ts:308-310` -- `setInterval(() => { refetch(); fetchRealReadings(); }, refreshInterval)` runs unconditionally with no error handling. If `fetchRealReadings` fails (line 32-77 in `fetchLatestReadingsBatch`), the error is caught and logged to console (line 68) but the interval continues at the same rate.
- **Root cause:** The hook uses manual polling instead of React Query's built-in refetchInterval with error backoff. A sustained server outage causes the hook to hammer the endpoint at the configured refresh rate (default 10s) indefinitely.
- **Impact:** During server outages, this hook generates unnecessary load with no backoff. The SCADA process view continues to show stale data with no visible error state for the operator.

### MEDIUM-004 `useWidgetData` sensor info cache is global and never expires

- **Surface:** S13
- **Evidence:** `/var/aqua-saas/web/modules/sensor-module/src/hooks/useWidgetData.ts:14` -- `const sharedSensorInfoCache = new Map<string, ...>()` is a module-scoped cache with no TTL, no size limit, and no tenant partitioning.
- **Root cause:** The cache was introduced as PERF-011 to avoid redundant sensor info fetches. It stores `{ name, type, thresholds }` keyed by `sensorId`. Since sensor info rarely changes, the lack of TTL is low-severity for correctness, but the lack of tenant partitioning means the cache can retain sensor names from a prior tenant after a switch, and the lack of size limit means it grows unbounded across the session lifetime.
- **Impact:** After a tenant switch, sensor info lookups may return names from the prior tenant. In long-running sessions with many sensors, the cache grows without bound.

### MEDIUM-005 `console.log`/`console.warn`/`console.error` used in sensor module hooks instead of structured logging

- **Surface:** S1, S14
- **Evidence:** `/var/aqua-saas/web/modules/sensor-module/src/hooks/useSensorSocket.ts:108,112,121,134` uses `console.warn` and `console.error` directly. `/var/aqua-saas/web/modules/sensor-module/src/hooks/useWidgetData.ts:629,665,734,821` uses `console.warn`. `/var/aqua-saas/web/modules/sensor-module/src/hooks/useSensorReadings.ts:68` uses `console.warn`.
- **Root cause:** These hooks predate the CLAUDE.md rule "console.log YASAK". Frontend hooks have no NestJS Logger equivalent, but the codebase standard calls for structured logging or at minimum suppressing debug output in production builds.
- **Impact:** In production, console output from WebSocket connection failures and fetch errors leaks internal state to anyone with browser devtools open.

### LOW-001 LiveSensorWidget shows "Canli" (live) indicator even during polling gaps

- **Surface:** S11
- **Evidence:** `/var/aqua-saas/web/modules/dashboard/src/widgets/LiveSensorWidget.tsx:200-203` -- the "Canli" indicator with green pulse animation is always rendered when a reading exists, regardless of data freshness. The 15-second polling interval means data can be up to 15 seconds stale while the indicator says "live."
- **Root cause:** The widget has no staleness detection. The `ConnectionStatusBanner` pattern (SCADA MEDIUM threshold of 30s) exists in the sensor module but is not used in the dashboard LiveSensorWidget.
- **Impact:** Minor UX misleading -- the user may believe data is real-time when it is polled at 15-second intervals. During backend outages, the indicator continues to show "live" while data is frozen.

### LOW-002 Farm realtime stream has limited reconnection attempts (10)

- **Surface:** S2
- **Evidence:** `/var/aqua-saas/web/modules/farm-module/src/hooks/useFarmRealtimeStream.ts:179` -- `reconnectionAttempts: 10` with max delay 5s. After 10 failed reconnection attempts, Socket.IO stops trying. No UI feedback is provided to the user that the farm event stream is dead.
- **Root cause:** The reconnection limit is reasonable for short outages but insufficient for extended maintenance windows. The messaging socket (line 100 in `useMessageSocket.ts`) uses `reconnectionAttempts: Infinity`, creating inconsistent resilience across namespaces.
- **Impact:** After ~50 seconds of continuous connection failure (10 attempts with exponential backoff up to 5s), the farm realtime stream silently dies. Cache invalidations stop, and the farm module's lists and details become stale without user awareness.

## Resolved Prior Findings

| Finding | Resolution |
|---|---|
| HIGH-003 (tenant-admin cache keys for useTenantActivity and useDevicePolling) | Commit `79ce984f` added `tenantId` to query keys in both hooks. `useTenantActivity` at line 66: `['tenant-activity', tenantId]`. `useDevicePolling` at line 124: `['edgeDevice', tenantId, deviceId]`. |

## Systemic Observations

1. **Tenant-scoped caching is inconsistently applied.** The platform has three distinct patterns: (a) `createTenantQueryKey(tenantId, ...)` in shared-ui (used by farm module, dashboard), (b) manual `tenantId` in key arrays (used by some hooks), and (c) no tenant in keys at all (useTenantData, useAlerts). The commit `79ce984f` addressed two specific hooks but did not establish a systematic fix. HIGH-004 is the direct consequence. Recommendation: migrate all `tenantKeys` in `useTenantData.ts` to include `tenantId` as the second segment, matching the `activityKeys` pattern already in `useTenantActivity.ts`.

2. **Global Zustand stores for WebSocket data have no tenant lifecycle.** CRITICAL-001 shows that the sensor module's global stores accumulate data without tenant awareness. This is a structural gap -- the stores were designed for single-tenant SPA sessions and need a `clearOnTenantChange` mechanism. Recommendation: add a `reset()` action to each Zustand store and call it from an auth context observer when `tenantId` changes, or key the stores by tenant.

3. **Manual polling (useState + setInterval) vs. React Query polling.** Three hooks (`useAlerts`, `useSensorReadings`, `useWidgetData`) use manual `setInterval` polling while the rest of the platform uses TanStack Query's `refetchInterval`. The manual hooks lack backoff, error state propagation, and tenant-scoped cache keys. Recommendation: migrate to TanStack Query for consistency and automatic benefits.

4. **Reconnection resilience is inconsistent across namespaces.** Messaging uses `reconnectionAttempts: Infinity`, farm uses `10`, sensor uses `10` (via socketFactory). There is no platform-wide reconnection policy or user-facing connection health indicator outside SCADA.

## Summary

| Severity | Count | New | Open from prior | Resolved |
|---|---|---|---|---|
| CRITICAL | 1 | 1 (CRITICAL-001) | 0 | 0 |
| HIGH | 4 | 2 (HIGH-004, HIGH-005) | 2 (HIGH-001, HIGH-002) | 1 (HIGH-003) |
| MEDIUM | 5 | 5 | 0 | 0 |
| LOW | 2 | 2 | 0 | 0 |
| **Total** | **12** | **10** | **2** | **1** |
