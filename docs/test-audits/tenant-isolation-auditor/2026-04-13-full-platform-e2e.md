# Tenant Isolation Auditor - 2026-04-13 Full Platform E2E

Scope reviewed: all backend services (`apps/**`), frontend shell and modules (`web/**`), shared libraries (`libs/**`), platform libraries (`platform/**`), AquaMobil PWA, NATS event routing, React Query cache keys, IndexedDB offline storage, WebSocket gateways, and database access patterns.

## Prior Cycle Verification

**CRITICAL-001 (NATS fanout trusts payload tenantId)** from 2026-04-11: **VERIFIED FIXED** in commit 79ce984f. `NatsBridgeService` now subscribes to `events.*.EdgeDeviceIoData` and `events.*.EdgeDeviceAlarm` wildcard subjects, extracts tenantId from the NATS subject (authoritative), and cross-validates against payload tenantId, dropping mismatched events.

Evidence: `apps/gateway-api/src/websocket/nats-bridge.service.ts:194`, `apps/gateway-api/src/websocket/nats-bridge.service.ts:235`

**CRITICAL-002 (UserDeleted cascade in wrong tenant schema)** from 2026-04-11: **VERIFIED FIXED** in commit 79ce984f. `MessagingNatsHandler` now uses `@EventPattern('events.*.UserDeleted')` (tenant-scoped wildcard), validates tenantId with `TENANT_ID_REGEX`, and performs a footprint check before destructive cascade.

Evidence: `apps/messaging-service/src/event-handlers/messaging-nats.handler.ts:212`, `apps/messaging-service/src/event-handlers/messaging-nats.handler.ts:113`

---

## Findings

### CRITICAL-001 - SensorReading NATS bridge subscribes to non-tenant-scoped subject, receives zero events in production

`NatsBridgeService.subscribeToSensorEvents()` subscribes to the raw NATS subject `events.SensorReading` (line 150). However, `NatsEventBus.deriveSubject()` publishes all events to `events.{tenantId}.SensorReading` (line 342-343 of nats-event-bus.ts). The subject `events.SensorReading` will never match `events.{tenantId}.SensorReading` because NATS requires exact subject segment matching.

**Impact:** In the current production state, the WebSocket bridge receives ZERO sensor reading events because the subscription subject does not match the publish subject. This is a **data availability failure** masquerading as a tenant isolation issue. However, if someone "fixes" this by switching to the legacy non-tenant-scoped subject format, the original CRITICAL-001 vulnerability (payload tenantId trust) would resurface for SensorReading events, because unlike EdgeDeviceIoData and EdgeDeviceAlarm, the SensorReading path has no subject-level tenant extraction or cross-validation.

The fix must change the subscription to `events.*.SensorReading` and extract tenantId from the subject (matching the EdgeDevice pattern).

Evidence:
- `apps/gateway-api/src/websocket/nats-bridge.service.ts:150` (subscribes to `events.SensorReading`)
- `platform/libs/event-bus/src/nats/nats-event-bus.ts:341-343` (publishes to `events.{tenantId}.SensorReading`)
- `apps/sensor-service/src/sensor/services/sensor-ingestion.service.ts:587` (publishes via eventBus with tenantId)
- `apps/sensor-service/src/ingestion/data-ingestion.service.ts:336` (publishes via eventBus with tenantId)

Cross-domain: `realtime-sync-auditor` should verify that the fix correctly routes sensor readings to the WebSocket layer.

### CRITICAL-002 - TenantProvisioned event uses non-tenant-scoped subject, allowing cross-tenant schema injection

`MessagingNatsHandler` listens on `@EventPattern('events.TenantProvisioned')` (line 352). This subject format has no tenant segment (`events.TenantProvisioned` instead of `events.*.TenantProvisioned` or `events.{tenantId}.TenantProvisioned`). The handler validates `tenantId` and `schemaName` format via regex, but it trusts the payload completely because there is no subject-level tenant proof.

**Impact:** A compromised container publishing to `events.TenantProvisioned` can trigger partition creation with any tenantId/schemaName combination. While the regex prevents SQL injection, the handler cannot verify that the publisher is authorized to provision that specific tenant. The `partitionManager.onApplicationBootstrap()` call creates messaging partitions for the supplied tenant.

**Severity escalation note:** This is a repeat pattern from the prior cycle's CRITICAL-002 (events without tenant-scoped subjects). Per auditor rules, repeated tenant-boundary defects in the same feature must be escalated by one severity level. However, since TenantProvisioned is a platform-level event (not tenant-specific), the non-tenant-scoped subject is arguably correct if NATS ACLs restrict which services can publish to this subject. The severity remains CRITICAL because no such ACL enforcement has been confirmed at runtime.

Evidence:
- `apps/messaging-service/src/event-handlers/messaging-nats.handler.ts:352`
- `platform/libs/event-bus/src/nats/nats-event-bus.ts:341-343` (deriveSubject uses `system` when tenantId is absent)

### HIGH-001 - Alert audit service getById and getByCorrelationId and getEntityHistory lack tenant filtering

`AlertAuditService` exposes three query methods that do not include tenantId in their WHERE clause:

1. `getById(id)` at line 694 queries only by `{ id: uuid }` with no tenant filter.
2. `getByCorrelationId(correlationId)` at line 703 queries only by `{ correlationId }` with no tenant filter.
3. `getEntityHistory(entityType, entityId)` at line 714 queries only by `{ entityType, entityId }` with no tenant filter.

Any caller who knows an audit entry UUID, correlation ID, or entity ID can read audit entries belonging to any tenant. The `query()` method (line 640) and `getStatistics()` (line 726) correctly accept and filter by tenantId, but these three methods bypass the pattern.

**Impact:** Cross-tenant audit data read. Audit entries contain operation details, user IDs, and entity references that belong to a specific tenant. An attacker who discovers or guesses an audit UUID can read another tenant's operational history.

Evidence:
- `apps/alert-engine/src/audit/alert-audit.service.ts:694-698` (getById)
- `apps/alert-engine/src/audit/alert-audit.service.ts:703-709` (getByCorrelationId)
- `apps/alert-engine/src/audit/alert-audit.service.ts:714-719` (getEntityHistory)
- `apps/alert-engine/src/audit/alert-audit.service.ts:658-659` (query method correctly filters)

Cross-domain: `data-readback-auditor` should verify that the controller/resolver exposing these methods passes tenantId from the authenticated context.

### HIGH-002 - Messaging ChannelMemberGuard and MessageOwnerGuard do not enforce tenant isolation

`ChannelMemberGuard` (line 54) queries `ChannelMember` by `{ channelId, userId, leftAt: IsNull() }` without any tenant filter. A user from Tenant A who knows a channelId in Tenant B can pass this guard if they somehow share the same userId (e.g., after a user migration or ID collision across tenants in a shared schema).

`MessageOwnerGuard` (line 49) queries `Message` by `{ id: messageId }` without any tenant filter. A user who knows a messageId from another tenant can read the message content through this guard (the senderId check may pass if the user IDs collide, or the admin role check on ChannelMember may grant access).

In the current schema-per-tenant architecture, this is partially mitigated because the messaging database connection's `search_path` should be set to the authenticated tenant's schema. However, if the guard runs before the schema middleware, or if the schema middleware fails silently, the guard falls through to the default schema and queries across all tenants.

**Impact:** Potential cross-tenant channel membership verification bypass and cross-tenant message content read. The severity depends on whether schema isolation consistently precedes guard execution.

Evidence:
- `apps/messaging-service/src/shared/guards/channel-member.guard.ts:54-59`
- `apps/messaging-service/src/shared/guards/message-owner.guard.ts:49-51`

### HIGH-003 - Weather cleanup job deletes data across all tenants without tenant scope

`WeatherSyncService.cleanupOldData()` (line 127) executes `DELETE` queries on `WeatherObservation` and `MarineObservation` tables with only a `WHERE observed_at < :cutoff` clause and no tenant filter. This deletes weather data for ALL tenants when invoked for any single tenant.

**Impact:** Cross-tenant data destruction. If one tenant triggers cleanup (or a cron job calls this method), all tenants lose weather data older than the cutoff.

Evidence:
- `apps/farm-service/src/weather/services/weather-sync.service.ts:131-146` (cleanupOldData)
- `apps/farm-service/src/weather/services/weather-sync.service.ts:35-36` (syncSite correctly filters by tenantId)

### HIGH-004 - Notification markAsRead does not include tenant filter

`InAppNotificationService.markAsRead(id, userId)` at line 103 queries by `{ id, recipient: userId, channel: NotificationChannel.IN_APP }` without a `tenantId` filter. A user in Tenant A who knows a notification ID from Tenant B can mark it as read, potentially altering the unread state for the target tenant's user.

The other methods (`getMyNotifications`, `getUnreadCount`, `markAllAsRead`) all correctly include `tenantId` in their queries.

Evidence:
- `apps/notification-service/src/notification/services/in-app.service.ts:103-110` (markAsRead missing tenantId)
- `apps/notification-service/src/notification/services/in-app.service.ts:67` (getMyNotifications correctly uses tenantId)

### MEDIUM-001 - React Query cache keys missing tenant prefix in TenantDashboard

`TenantDashboard.tsx` uses query keys `['dashboard', 'modules']`, `['dashboard', 'users']`, and `['dashboard', 'subscription']` (lines 150, 172, 182) without including tenantId. The `createTenantQueryKey` factory exists in `web/shared-ui/src/utils/tenant-query-keys.ts` but is not used here.

**Impact:** In admin-impersonation or tenant-switching scenarios, switching tenants serves stale dashboard data (modules, users, subscription) from the previous tenant's cache. The `handleRefresh` function invalidates `['dashboard']` which partially mitigates this on manual refresh, but automatic stale-while-revalidate returns previous tenant's data on navigation.

Evidence:
- `web/modules/tenant-admin/src/pages/TenantDashboard.tsx:150,172,182`
- `web/shared-ui/src/utils/tenant-query-keys.ts:39-44` (factory exists but not used)

### MEDIUM-002 - HR module query keys lack tenant prefix (certificationKeys, leaveKeys, hrDashboardStats, scheduling-employees)

Multiple HR module query key factories use non-tenant-prefixed keys:

1. `certificationKeys.all` is `['certifications']` with no tenant segment (`web/modules/hr-module/src/hooks/useCertifications.ts:51`)
2. `leaveKeys.all` is `['leaves']` with no tenant segment (`web/modules/hr-module/src/hooks/useLeaves.ts:42`)
3. `useHRDashboardStats` uses `['hrDashboardStats']` (`web/modules/hr-module/src/hooks/useEmployees.ts:180`)
4. `WeeklySchedulePage` uses `['scheduling-employees']` (`web/modules/hr-module/src/pages/scheduling/WeeklySchedulePage.tsx:178`)
5. `useCheckLeaveOverlap` uses `['leaveOverlap', ...]` without tenant (`web/modules/hr-module/src/hooks/useLeaves.ts:238`)
6. `useCalculateLeaveDays` uses `['leaveDays', ...]` without tenant (`web/modules/hr-module/src/hooks/useLeaves.ts:265`)

**Impact:** On tenant switch (admin impersonation), HR data from the previous tenant is served from cache. Employee names, certification statuses, leave balances, and scheduling data leak across tenant context switches.

Evidence: File paths and line numbers listed above.

### MEDIUM-003 - Messaging query keys in AquaMobil missing tenant prefix for invalidation patterns

Several cache invalidation calls in AquaMobil messaging hooks use non-tenant-prefixed keys:

1. `useMessageSocket` invalidates `['messaging', 'channels']` and `['messaging', 'unreadCount']` without tenantId (`web/apps/aquamobil/src/hooks/useMessageSocket.ts:160,162,207`)
2. `useSendMessage` invalidates `['messaging', 'channels']` without tenantId (`web/apps/aquamobil/src/hooks/useSendMessage.ts:166`)
3. `NewChatPage` uses `['messaging', 'aiPersonas']` without tenantId (`web/apps/aquamobil/src/pages/messaging/NewChatPage.tsx:199`)
4. `ForwardModal` invalidates `['messaging', 'messages']` and `['messaging', 'channels']` without tenantId (`web/apps/aquamobil/src/components/messaging/ForwardModal.tsx:114,115`)
5. `MyLeavesPage` invalidates `['leaveRequests']` and `['leaveBalances']` without tenantId (`web/apps/aquamobil/src/pages/leave/MyLeavesPage.tsx:36,37`)

Note: Some AquaMobil hooks correctly include tenantId (e.g., `useUnreadCount` uses `['messaging', 'unreadCount', tenantId]`), creating an inconsistency where the query key has tenantId but the invalidation pattern does not, meaning invalidation may silently fail to clear the correct entry.

Evidence: File paths and line numbers listed above.

### MEDIUM-004 - TenantAwareRepository schema name validation regex does not match UUID format

`TenantAwareRepository.executeRaw()` at line 375 validates schema names with `/^tenant_[a-f0-9]{16}$/`. A tenant schema name is `tenant_{uuid}` where UUID is 32 hex chars + 4 hyphens = 36 characters (e.g., `tenant_12345678-1234-1234-1234-123456789012`). The regex expects only 16 hex characters with no hyphens, which means this validation ALWAYS fails for valid tenant schema names.

**Impact:** `executeRaw()` always throws `SECURITY: Invalid schema name format` for any tenant schema, falling through to the non-schema-scoped `dataSource.query()` path only when `this.schemaName` is null. If `schemaName` is set (which it will be for any authenticated tenant request), every `executeRaw()` call throws. This is a denial-of-service bug rather than a data leak, but it indicates the validation code was never exercised in production.

Evidence:
- `libs/backend-common/src/database/tenant-aware.repository.ts:375`
- Correct UUID format would need pattern: `/^tenant_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/`

### LOW-001 - Notification retention cleanup deletes across all tenants

`NotificationRetentionService.cleanupOldLogs()` (line 57) deletes notification logs older than the retention window across ALL tenants with no tenant filter. While this is intentionally a global cleanup job (and the behavior is defensible for a shared `notification_logs` table), it should be documented that tenant-specific retention policies are not supported. If any tenant has regulatory requirements for longer retention (e.g., financial services), this global cleanup violates those requirements.

Evidence:
- `apps/notification-service/src/notification/services/notification-retention.service.ts:57-63`

### LOW-002 - useMySchedule query key does not include tenantId

`useMySchedule` uses `['mySchedule', user?.id, weekStartDate]` (line 118) without tenantId. The offline cache correctly uses tenant-scoped keys (line 139: `cacheData(tenantId, cacheKey, ...)`), but the React Query cache key lacks the tenant prefix. A user who belongs to multiple tenants (via cross-tenant access) could see schedule data from the wrong tenant in the React Query cache.

Evidence:
- `web/apps/aquamobil/src/hooks/useMySchedule.ts:118`

---

## Reviewed Without Additional Tenant-Leak Findings

The following areas were reviewed and confirmed to have correct tenant isolation:

- **TenantAwareRepository**: Extracts tenantId only from JWT or TenantGuard-validated sources. `getScopedRepository()` enforces tenant filtering on all reads. `getRepository()` throws. (`libs/backend-common/src/database/tenant-aware.repository.ts`)

- **TenantRlsService**: RLS policies use `app.current_tenant` with parameterized `set_config` and transaction-scoped `SET LOCAL`. UUID validation prevents injection. (`libs/backend-common/src/database/rls/tenant-rls.service.ts`)

- **TenantIsolationGuard**: Validates JWT tenantId, blocks cross-tenant access except for platform_admin/super_admin. UUID format validation on all inputs. (`apps/gateway-api/src/guards/tenant-isolation.guard.ts`)

- **@Tenant() decorator**: Reads exclusively from `req.user.tenantId` (JWT) and `req.tenantId` (TenantGuard). Never reads headers, query params, or body. (`libs/backend-common/src/decorators/tenant.decorator.ts`)

- **Event store service**: All queries include tenantId filter in WHERE clause. (`apps/event-store-service/src/event-store/services/event-store.service.ts:216,265`)

- **AI conversation service**: All CRUD operations require tenantId + userId in WHERE clause. (`apps/ai-service/src/conversation/conversation.service.ts`)

- **In-app notification service**: getMyNotifications, getUnreadCount, and markAllAsRead all include tenantId. (Only markAsRead is missing it -- see HIGH-004.)

- **AquaMobil offline queue**: Cache entries use `cache_${tenantId}:${key}` format with AES-GCM encryption. (`web/apps/aquamobil/src/pwa/offline-queue.ts:314-326`)

- **Alert resolver and escalation policy resolver**: All GraphQL queries/mutations use `@Tenant()` decorator to derive tenantId from JWT. (`apps/alert-engine/src/alert/resolvers/alert.resolver.ts`, `apps/alert-engine/src/alert/resolvers/escalation-policy.resolver.ts`)

- **Sensor reading event handler (alert-engine)**: Uses `eventBus.subscribe('SensorReading', this)` which correctly subscribes to `events.*.SensorReading`. Validates tenantId format and creates AsyncLocalStorage context. (`apps/alert-engine/src/alert/event-handlers/sensor-reading.handler.ts`)

- **Farm service query handlers**: Checked list-chemicals, list-departments, list-systems, list-species, list-batches -- all include tenantId in createQueryBuilder WHERE clauses.

- **HR attendance handlers**: All query handlers (get-todays-attendance, get-attendance-summary, get-attendance-records) include tenantId filter.

- **Billing scheduler**: Operates on global subscription/invoice tables with tenantId per row. Cross-tenant interference is prevented by per-row tenantId ownership. Advisory locks prevent concurrent execution.

- **Config service**: Cache keys include tenantId prefix `${tenantId}:${service}:${key}`. Database queries include tenantId in WHERE. Global fallback is intentional and documented.

---

## Conclusion

Two CRITICAL findings remain:

1. **SensorReading WebSocket bridge** subscribes to a non-existent NATS subject (`events.SensorReading` instead of `events.*.SensorReading`), causing a complete real-time sensor data blackout AND leaving the pathway vulnerable to the same payload-trust vulnerability that was fixed for EdgeDevice events.

2. **TenantProvisioned event** uses a non-tenant-scoped subject without runtime NATS ACL enforcement, allowing any compromised container to trigger partition creation for arbitrary tenants.

Three HIGH findings require immediate remediation: alert audit service cross-tenant reads, messaging guards missing tenant filters, and weather data cross-tenant deletion.

Four MEDIUM findings affect React Query cache isolation for admin-impersonation/tenant-switching scenarios across the TenantDashboard, HR module, AquaMobil messaging, and the TenantAwareRepository schema validation regex.

Deployment confidence is blocked until CRITICAL-001 (SensorReading subject mismatch) and HIGH-003 (weather cleanup cross-tenant deletion) are resolved. The remaining findings should be prioritized in the next remediation cycle.
