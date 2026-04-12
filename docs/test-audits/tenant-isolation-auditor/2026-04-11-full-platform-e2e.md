# Tenant Isolation Auditor - 2026-04-11 Full Platform E2E

Scope reviewed: web shell, web microfrontends, AquaMobil, gateway API, messaging service, shared backend tenant primitives, and admin/database surfaces.

## Findings

### CRITICAL-001 - Realtime edge-device fan-out trusts payload tenantId instead of a tenant-scoped routing key
`NatsBridgeService` subscribes to legacy subjects `events.EdgeDeviceIoData` and `events.EdgeDeviceAlarm`, then forwards to Socket.IO rooms using `tenantId` from the decoded message body. The bridge does not derive tenant ownership from the NATS subject, and it does not perform an ownership reconciliation step before broadcasting. That means a malformed or compromised publisher can redirect a live device event into another tenant room by altering the payload tenantId. The downstream gateway then emits the event to `edgeIo:{tenantId}:{deviceCode}` using that supplied tenant context.

Evidence:
[`apps/gateway-api/src/websocket/nats-bridge.service.ts:192`](/var/aqua-saas/apps/gateway-api/src/websocket/nats-bridge.service.ts#L192)
[`apps/gateway-api/src/websocket/nats-bridge.service.ts:200`](/var/aqua-saas/apps/gateway-api/src/websocket/nats-bridge.service.ts#L200)
[`apps/gateway-api/src/websocket/nats-bridge.service.ts:209`](/var/aqua-saas/apps/gateway-api/src/websocket/nats-bridge.service.ts#L209)
[`apps/gateway-api/src/websocket/nats-bridge.service.ts:223`](/var/aqua-saas/apps/gateway-api/src/websocket/nats-bridge.service.ts#L223)
[`apps/gateway-api/src/websocket/nats-bridge.service.ts:230`](/var/aqua-saas/apps/gateway-api/src/websocket/nats-bridge.service.ts#L230)
[`apps/gateway-api/src/websocket/nats-bridge.service.ts:239`](/var/aqua-saas/apps/gateway-api/src/websocket/nats-bridge.service.ts#L239)
[`apps/gateway-api/src/websocket/sensor-readings.gateway.ts:314`](/var/aqua-saas/apps/gateway-api/src/websocket/sensor-readings.gateway.ts#L314)

Cross-domain dependency:
`realtime-sync-auditor` should own the transport/replay contract for this surface because the defect is in event fan-out, not in UI rendering.

### CRITICAL-002 - UserDeleted cascade can execute destructive writes in the wrong tenant schema
`MessagingNatsHandler` listens on `events.UserDeleted`, reads `data.tenantId` from the payload, and immediately uses it to set `search_path` before anonymizing and deleting message data. The event subject does not carry a tenant segment, so there is no subject-level proof that the payload tenant matches the routing context. A bad publisher can therefore drive the cascade into another tenant schema and execute destructive cleanup against the wrong tenant's messaging data.

Evidence:
[`apps/messaging-service/src/event-handlers/messaging-nats.handler.ts:109`](/var/aqua-saas/apps/messaging-service/src/event-handlers/messaging-nats.handler.ts#L109)
[`apps/messaging-service/src/event-handlers/messaging-nats.handler.ts:119`](/var/aqua-saas/apps/messaging-service/src/event-handlers/messaging-nats.handler.ts#L119)
[`apps/messaging-service/src/event-handlers/messaging-nats.handler.ts:212`](/var/aqua-saas/apps/messaging-service/src/event-handlers/messaging-nats.handler.ts#L212)
[`apps/messaging-service/src/event-handlers/messaging-nats.handler.ts:221`](/var/aqua-saas/apps/messaging-service/src/event-handlers/messaging-nats.handler.ts#L221)
[`apps/messaging-service/src/event-handlers/messaging-nats.handler.ts:272`](/var/aqua-saas/apps/messaging-service/src/event-handlers/messaging-nats.handler.ts#L272)

Cross-domain dependency:
`workflow-state-auditor` should review the delete/anonymize lifecycle semantics that trigger this event, because the tenant breach is caused by a destructive state transition propagating through NATS.

## Reviewed Without Additional Tenant-Leak Findings

No additional tenant-isolation defects were confirmed in the reviewed cache-key, mobile-storage, guard, RLS, repository, or admin database-explorer paths.

Checked examples:
[`web/shared-ui/src/utils/tenant-query-keys.ts:19`](/var/aqua-saas/web/shared-ui/src/utils/tenant-query-keys.ts#L19)
[`web/apps/aquamobil/src/pwa/offline-queue.ts:303`](/var/aqua-saas/web/apps/aquamobil/src/pwa/offline-queue.ts#L303)
[`apps/gateway-api/src/guards/tenant-isolation.guard.ts:61`](/var/aqua-saas/apps/gateway-api/src/guards/tenant-isolation.guard.ts#L61)
[`libs/backend-common/src/database/tenant-aware.repository.ts:45`](/var/aqua-saas/libs/backend-common/src/database/tenant-aware.repository.ts#L45)
[`libs/backend-common/src/database/rls/tenant-rls.service.ts:65`](/var/aqua-saas/libs/backend-common/src/database/rls/tenant-rls.service.ts#L65)
[`apps/admin-api-service/src/database-management/controllers/explorer.controller.ts:283`](/var/aqua-saas/apps/admin-api-service/src/database-management/controllers/explorer.controller.ts#L283)

## Conclusion

Deployment confidence is blocked for tenant-isolated realtime and async-delete flows until the routing key becomes the authoritative tenant source or the payload is cryptographically/structurally bound to it end to end.
