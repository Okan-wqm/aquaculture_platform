# Hotspot per service — rollup

Cycle: `2026-04-22-cold-audit`.

| Service | Total score | Hotspot files | Top 3 files |
|---|---|---|---|
| `(other)` | 1193 | 76 | `docker-compose.droplet.yml` (134)<br/>`.github/workflows/deploy-digitalocean.yml` (88)<br/>`docs/reviews/_registry/findings.jsonl` (54) |
| `web/sensor-module` | 611 | 91 | `web/modules/sensor-module/src/components/scada-builder/edges/OrthogonalEdge.tsx` (26)<br/>`web/modules/sensor-module/src/components/process-editor/edges/OrthogonalEdge.tsx` (26)<br/>`web/modules/sensor-module/src/pages/automation/AutomationProgramEditorPage.tsx` (23) |
| `apps/sensor-service` | 379 | 33 | `apps/sensor-service/src/ingestion/mqtt-listener.service.ts` (49)<br/>`apps/sensor-service/src/app.module.ts` (45)<br/>`apps/sensor-service/src/automation/automation.service.ts` (38) |
| `apps/farm-service` | 350 | 55 | `apps/farm-service/src/app.module.ts` (52)<br/>`apps/farm-service/src/storage/handlers/record-stock-movement.handler.ts` (39)<br/>`apps/farm-service/src/scheduler/feeding-scheduler.service.ts` (27) |
| `apps/hr-service` | 257 | 51 | `apps/hr-service/src/app.module.ts` (42)<br/>`apps/hr-service/src/hr/entities/employee.entity.ts` (17)<br/>`apps/hr-service/src/hr/hr.resolver.ts` (14) |
| `apps/messaging-service` | 219 | 21 | `apps/messaging-service/src/channel/entities/channel-member.entity.ts` (31)<br/>`apps/messaging-service/src/app.module.ts` (30)<br/>`apps/messaging-service/src/message/entities/message-attachment.entity.ts` (21) |
| `libs/backend-common` | 215 | 15 | `libs/backend-common/src/database/schema-manager.service.ts` (51)<br/>`libs/backend-common/src/database/index.ts` (42)<br/>`libs/backend-common/src/index.ts` (32) |
| `apps/auth-service` | 171 | 9 | `apps/auth-service/src/modules/authentication/services/authentication.service.ts` (46)<br/>`apps/auth-service/src/app.module.ts` (33)<br/>`apps/auth-service/src/modules/tenant/services/tenant.service.ts` (22) |
| `web/farm-module` | 136 | 35 | `web/modules/farm-module/src/pages/water-chemistry/engine/water-quality.ts` (14)<br/>`web/modules/farm-module/src/pages/water-chemistry/engine/reagents.ts` (12)<br/>`web/modules/farm-module/src/pages/water-chemistry/engine/deffeyes-data.ts` (8) |
| `web/apps` | 128 | 12 | `web/apps/aquamobil/src/pages/mortality/RecordMortalityPage.tsx` (18)<br/>`web/apps/aquamobil/src/App.tsx` (15)<br/>`web/apps/aquamobil/src/pwa/offline-queue.ts` (14) |
| `apps/admin-api-service` | 120 | 14 | `apps/admin-api-service/src/app.module.ts` (36)<br/>`apps/admin-api-service/src/tenant/services/tenant-provisioning.service.ts` (21)<br/>`apps/admin-api-service/src/database-management/controllers/explorer.controller.ts` (17) |
| `apps/billing-service` | 110 | 21 | `apps/billing-service/src/app.module.ts` (30)<br/>`apps/billing-service/src/billing/query-handlers/get-tenant-billing.handler.ts` (9)<br/>`apps/billing-service/src/billing/event-handlers/tenant-subscription-requested.handler.ts` (9) |
| `web/tenant-admin` | 100 | 11 | `web/modules/tenant-admin/src/pages/TenantDashboard.tsx` (25)<br/>`web/modules/tenant-admin/src/pages/TenantUsers.tsx` (15)<br/>`web/modules/tenant-admin/src/pages/TenantSettings.tsx` (12) |
| `libs/node-components` | 76 | 16 | `libs/node-components/src/edges/OrthogonalEdge.tsx` (12)<br/>`libs/node-components/src/edges/MultiHandleEdge.tsx` (12)<br/>`libs/node-components/src/nodes/ValveNode.tsx` (10) |
| `apps/gateway-api` | 63 | 7 | `apps/gateway-api/src/app.module.ts` (35)<br/>`apps/gateway-api/src/main.ts` (18)<br/>`apps/gateway-api/src/middleware/tenant-context.middleware.ts` (3) |
| `apps/notification-service` | 59 | 6 | `apps/notification-service/src/app.module.ts` (27)<br/>`apps/notification-service/src/notification/services/notification-dispatcher.service.ts` (12)<br/>`apps/notification-service/src/main.ts` (12) |
| `apps/config-service` | 46 | 5 | `apps/config-service/src/app.module.ts` (28)<br/>`apps/config-service/src/configuration/handlers/upsert-configuration.handler.ts` (6)<br/>`apps/config-service/src/configuration/handlers/update-configuration.handler.ts` (6) |
| `apps/ai-service` | 44 | 9 | `apps/ai-service/src/app.module.ts` (24)<br/>`apps/ai-service/src/safety/ssrf-validator.service.ts` (4)<br/>`apps/ai-service/src/safety/output-pii-scanner.service.ts` (4) |
| `web/shared-ui` | 38 | 5 | `web/shared-ui/src/utils/api-client.ts` (18)<br/>`web/shared-ui/src/components/Layout/Sidebar.tsx` (14)<br/>`web/shared-ui/src/components/Modal/DeleteConfirmationDialog.tsx` (2) |
| `libs/aquaculture-engines` | 36 | 6 | `libs/aquaculture-engines/src/water-chemistry/water-quality.ts` (10)<br/>`libs/aquaculture-engines/src/water-chemistry/reagents.ts` (10)<br/>`libs/aquaculture-engines/src/water-chemistry/deffeyes-data.ts` (8) |
| `apps/alert-engine` | 33 | 3 | `apps/alert-engine/src/app.module.ts` (31)<br/>`apps/alert-engine/src/risk-scoring/risk-calculator.service.ts` (1)<br/>`apps/alert-engine/src/risk-scoring/severity-classifier.service.ts` (1) |
| `web/shell` | 29 | 3 | `web/shell/vite.config.ts` (16)<br/>`web/shell/src/layouts/MainLayout.tsx` (11)<br/>`web/shell/src/pages/LoginPage.tsx` (2) |
| `apps/hydroponics-service` | 28 | 1 | `apps/hydroponics-service/src/app.module.ts` (28) |
| `apps/observability-service` | 27 | 2 | `apps/observability-service/src/app.module.ts` (17)<br/>`apps/observability-service/src/database/migrations/1805000000000-AddTenantCostRollup.ts` (10) |
| `platform/event-bus` | 25 | 3 | `platform/libs/event-bus/src/nats/nats-event-bus.ts` (22)<br/>`platform/libs/event-bus/src/nats/nats.module.ts` (2)<br/>`platform/libs/event-bus/src/nats/nats-request-reply.ts` (1) |
| `web/admin-panel` | 23 | 10 | `web/modules/admin-panel/src/components/AdminSidebar.tsx` (4)<br/>`web/modules/admin-panel/src/services/http-client.ts` (3)<br/>`web/modules/admin-panel/src/pages/system/ErrorTrackingPage.tsx` (2) |
| `web/hr-module` | 20 | 3 | `web/modules/hr-module/src/hooks/useEmployees.ts` (12)<br/>`web/modules/hr-module/src/pages/PayrollPage.tsx` (6)<br/>`web/modules/hr-module/src/pages/leaves/LeavesPage.tsx` (2) |
| `apps/sensor-ingestion` | 17 | 1 | `apps/sensor-ingestion/src/main.rs` (17) |
| `apps/event-store-service` | 16 | 1 | `apps/event-store-service/src/app.module.ts` (16) |
| `web/hydroponics-module` | 16 | 6 | `web/modules/hydroponics-module/src/hooks/useHydroponicsConfig.ts` (6)<br/>`web/modules/hydroponics-module/src/pages/solution/tabs/PreviousDrainageTab.tsx` (2)<br/>`web/modules/hydroponics-module/src/pages/pid-simulator/components/TimeSeriesCharts.tsx` (2) |
| `libs/event-contracts` | 15 | 1 | `libs/event-contracts/src/index.ts` (15) |
| `platform/outbox` | 13 | 2 | `platform/libs/outbox/src/outbox-entity.base.ts` (10)<br/>`platform/libs/outbox/src/outbox-publisher.service.ts` (3) |
| `apps/db-migrate` | 10 | 1 | `apps/db-migrate/src/migration-orchestrator.ts` (10) |
| `web/dashboard` | 4 | 1 | `web/modules/dashboard/src/components/icons.tsx` (4) |
| `libs/migration-harness` | 3 | 1 | `libs/migration-harness/src/expect-no-drift.ts` (3) |
