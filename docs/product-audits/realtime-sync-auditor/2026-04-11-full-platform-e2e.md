# Realtime Sync Auditor
Topic: `2026-04-11-full-platform-e2e`

Scope: polling, SSE, notifications, sync status, job progress, live dashboards, and post-write convergence across the platform.

## Findings

### HIGH-001 AquaMobil notifications converge only on push, not on the fallback poll
- Evidence: [`/var/aqua-saas/web/apps/aquamobil/src/hooks/useNotifications.ts:20`](/var/aqua-saas/web/apps/aquamobil/src/hooks/useNotifications.ts#L20) only reads `isAuthenticated` from auth, [`/var/aqua-saas/web/apps/aquamobil/src/hooks/useNotifications.ts:90`](/var/aqua-saas/web/apps/aquamobil/src/hooks/useNotifications.ts#L90) starts one initial `refetch()`, and [`/var/aqua-saas/web/apps/aquamobil/src/hooks/useNotifications.ts:96`](/var/aqua-saas/web/apps/aquamobil/src/hooks/useNotifications.ts#L96) polls only `fetchUnreadCount()` every 5 minutes.
- Evidence: the same hook feeds the live surfaces in [`/var/aqua-saas/web/apps/aquamobil/src/pages/notifications/NotificationsPage.tsx:23`](/var/aqua-saas/web/apps/aquamobil/src/pages/notifications/NotificationsPage.tsx#L23), [`/var/aqua-saas/web/apps/aquamobil/src/components/NotificationBell.tsx:7`](/var/aqua-saas/web/apps/aquamobil/src/components/NotificationBell.tsx#L7), and [`/var/aqua-saas/web/apps/aquamobil/src/layouts/MobileLayout.tsx:40`](/var/aqua-saas/web/apps/aquamobil/src/layouts/MobileLayout.tsx#L40).
- Root cause: the authoritative notification list from `myNotifications` is treated as push-only, while the documented fallback path only refreshes the unread badge. In FCM-disabled, permission-denied, or foreground-push-loss scenarios, the list can remain stale indefinitely. Because the hook also ignores tenant changes, the same component instance can keep showing the previous tenant's notification state until a manual refetch or remount.
- Impact: the notification feed and badge can diverge from backend truth, and tenant switches can preserve prior-context notifications in the UI.
- Cross-domain dependency: send list freshness aspects to `list-visibility-auditor` and tenant switch leakage to `tenant-isolation-auditor`.

### HIGH-002 Offline queue auto-sync can latch after a zero-success run
- Evidence: [`/var/aqua-saas/web/apps/aquamobil/src/hooks/useOfflineQueue.tsx:330`](/var/aqua-saas/web/apps/aquamobil/src/hooks/useOfflineQueue.tsx#L330) only clears `hasSyncedOnReconnectRef` when `result.success > 0`, and the reconnect effect at [`/var/aqua-saas/web/apps/aquamobil/src/hooks/useOfflineQueue.tsx:368`](/var/aqua-saas/web/apps/aquamobil/src/hooks/useOfflineQueue.tsx#L368) only triggers auto-sync when that ref is false.
- Root cause: the reconnect guard is modeled as a sticky success latch instead of a transient "pending work on reconnect" state. A batch that returns zero successes, or a run that fails before any item is committed, leaves the guard set. Any new queued operations added while still online will not auto-sync until the app goes offline and comes back online again.
- Impact: the Sync Status screen can show online connectivity while queued writes never converge unless the user manually intervenes.
- Cross-domain dependency: send mobile convergence and queued-write behavior to `mobile-app-auditor` and state transition fallout to `workflow-state-auditor`.

### HIGH-003 Tenant-admin live polling caches are not tenant-scoped
- Evidence: [`/var/aqua-saas/web/modules/tenant-admin/src/hooks/useTenantActivity.ts:64`](/var/aqua-saas/web/modules/tenant-admin/src/hooks/useTenantActivity.ts#L64) defines a global `tenant-activity` key and [`/var/aqua-saas/web/modules/tenant-admin/src/hooks/useTenantActivity.ts:77`](/var/aqua-saas/web/modules/tenant-admin/src/hooks/useTenantActivity.ts#L77) polls tenant activity on that key; [`/var/aqua-saas/web/modules/tenant-admin/src/hooks/useDevicePolling.ts:121`](/var/aqua-saas/web/modules/tenant-admin/src/hooks/useDevicePolling.ts#L121) does the same for edge-device truth with `['edgeDevice', deviceId]`.
- Evidence: the tenant dashboard uses the same pattern for live summaries at [`/var/aqua-saas/web/modules/tenant-admin/src/pages/TenantDashboard.tsx:149`](/var/aqua-saas/web/modules/tenant-admin/src/pages/TenantDashboard.tsx#L149).
- Root cause: the backend calls are tenant-bound through auth/header context, but the client cache keys do not encode tenant identity. In a multi-tenant admin session or impersonation flow, cached live activity, device status, and dashboard summaries can survive a tenant change and continue rendering prior-tenant truth until a separate invalidation or remount occurs.
- Impact: live admin dashboards can show stale or cross-context data even though the polling loop is still running.
- Cross-domain dependency: send the isolation aspect to `tenant-isolation-auditor` and the dashboard truth aspect to `chart-widget-auditor`.
