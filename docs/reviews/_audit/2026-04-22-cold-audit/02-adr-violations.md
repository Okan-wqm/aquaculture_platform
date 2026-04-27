# ADR / code-quality violations

Cycle: `2026-04-22-cold-audit`.

## ADR-011 (entity missing schema)

Hits: **1** files.

- `apps/farm-service/src/database/entities/base.entity.ts`

## ADR — getRepository (tenant isolation bypass)

Hits: **89** files.

- `apps/farm-service/src/storage/handlers/record-stock-movement.handler.ts`
- `apps/farm-service/src/scheduler/feeding-scheduler.service.ts`
- `apps/auth-service/src/modules/authentication/services/authentication.service.ts`
- `apps/sensor-service/src/automation/automation.service.ts`
- `apps/auth-service/src/modules/tenant/services/user-lifecycle.service.ts`
- `apps/sensor-service/src/ingestion/mqtt-listener.service.ts`
- `apps/farm-service/src/storage/handlers/receive-delivery.handler.ts`
- `apps/billing-service/src/billing/query-handlers/get-tenant-billing.handler.ts`
- `apps/billing-service/src/billing/event-handlers/tenant-subscription-requested.handler.ts`
- `apps/billing-service/src/billing/handlers/change-subscription-plan.handler.ts`
- `apps/farm-service/src/feed/handlers/create-feed.handler.ts`
- `apps/farm-service/src/feeding/resolvers/feeding-program.resolver.ts`
- `apps/farm-service/src/storage/handlers/approve-inventory-count.handler.ts`
- `apps/farm-service/src/storage/handlers/create-inventory-count.handler.ts`
- `libs/backend-common/src/database/tenant-aware.repository.ts`
- `apps/hr-service/src/aquaculture/handlers/create-work-rotation.handler.ts`
- `apps/hr-service/src/training/handlers/revoke-certification.handler.ts`
- `apps/billing-service/src/modules/metering/usage-aggregator.service.ts`
- `apps/billing-service/src/billing/handlers/create-invoice.handler.ts`
- `apps/hr-service/src/performance/handlers/create-goal.handler.ts`
- `apps/hr-service/src/performance/handlers/create-performance-review.handler.ts`
- `apps/auth-service/src/modules/tenant/services/tenant-admin.service.ts`
- `apps/messaging-service/test/e2e-setup.ts`
- `apps/messaging-service/src/compliance/services/legal-hold.service.ts`
- `apps/sensor-service/src/sensor-type/channel-detection.service.ts`

## Code Quality — `as any`

Hits: **17** files.

- `web/modules/sensor-module/src/services/st-websocket.service.ts`
- `web/modules/sensor-module/src/hooks/useScadaKeyboardShortcuts.ts`
- `web/shared-ui/src/utils/api-client.ts`
- `web/modules/sensor-module/src/hooks/useScadaLiveData.ts`
- `web/modules/sensor-module/src/hooks/useEdgeIoSocket.ts`
- `web/modules/sensor-module/src/hooks/useSensorSocket.ts`
- `web/modules/sensor-module/src/hooks/socketFactory.ts`
- `web/modules/sensor-module/src/simulation/st-parser-lite.ts`
- `apps/admin-api-service/src/policy/services/ingest-backend-policy.service.ts`
- `apps/farm-service/src/storage/handlers/record-stock-movement.handler.ts`
- `apps/farm-service/src/storage/commands/update-storage-location.command.ts`
- `platform/libs/outbox/src/outbox-publisher.service.ts`
- `libs/backend-common/src/database/rls/rls-connection-bootstrap.service.ts`
- `libs/backend-common/src/database/tenant-connection-bootstrap.service.ts`
- `web/modules/sensor-module/src/store/processStore.ts`
- `web/modules/sensor-module/src/store/scada/screenIO.ts`
- `web/modules/admin-panel/src/services/http-client.ts`

## Code Quality — @ts-ignore/@ts-expect-error

Hits: **3** files.

- `apps/sensor-service/src/automation/compiler/worker/st-worker-pool.service.ts`
- `libs/migration-harness/src/expect-no-drift.ts`
- `web/modules/sensor-module/src/components/automation/st-language.ts`

## Code Quality — raw console.*

Hits: **3** files.

- `libs/node-components/src/registry/NodeRegistry.ts`
- `libs/backend-common/src/bootstrap/safe-error-logger.ts`
- `libs/backend-common/src/database/nats-migration-event-sink.ts`
