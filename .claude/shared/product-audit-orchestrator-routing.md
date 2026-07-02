# Product-Audit Orchestrator — Phase 1 Routing Table (Lane-B)

**Audience:** `.claude/agents/product-audit/orchestrator.md` includes this
fragment via `@.claude/shared/product-audit-orchestrator-routing.md`. Tests
(`tests/invariants/orchestrator-routing-coverage.spec.ts` reverse coverage
check + `tests/invariants/agent-ownership-uniqueness.spec.ts` routing-table
glob-uniqueness check) read this file to assert every Lane-B roster agent
is reachable and no duplicate-glob → different-primary conflicts exist.

Hand-edit only in orchestrator-maintenance cycles. Adding a new Lane-B
product auditor requires a new row here + a dispatch bullet in the main
orchestrator's "Route work" list + a `prompt-writer` review.

## Routing Table

Phase 1 of the Lane-B product audit cycle maps every product surface to one
or more auditors via these globs. Primary agent performs the surface audit;
Also-Notify agents receive cross-cutting context.

| File Pattern / Surface | Primary Agent | Also Notify |
|---|---|---|
| `web/**/pages/**/*Page.tsx`, `web/**/components/**/*Modal.tsx`, `web/**/components/**/*Form*.tsx` | `ui-action-mapper` | `form-write-auditor`, `button-action-auditor` |
| `web/apps/aquamobil/**` | `mobile-app-auditor` | `ui-action-mapper`, `tenant-isolation-auditor`, `realtime-sync-auditor` |
| `**/*Table*.tsx`, `**/*List*.tsx`, `web/shared-ui/src/components/{Table,DataTable}/**` | `table-grid-auditor` | `list-visibility-auditor`, `data-readback-auditor` |
| `**/*Chart*.tsx`, `**/*Widget*.tsx`, `**/*Dashboard*.tsx`, `**/*Kpi*.tsx` | `chart-widget-auditor` | `data-readback-auditor`, `realtime-sync-auditor` |
| `**/*Upload*.tsx`, `**/*Import*.tsx`, `**/*Export*.tsx`, `**/*Attachment*.tsx` | `file-transfer-auditor` | `form-write-auditor`, `data-readback-auditor`, `access-boundary-auditor` |
| hooks or endpoints for `polling`, `sync`, `SSE`, notifications, live status | `realtime-sync-auditor` | `list-visibility-auditor`, `mobile-app-auditor` |
| guards, roles, permissions, impersonation, feature flags | `access-boundary-auditor` | `tenant-isolation-auditor`, `workflow-state-auditor` |
| DTO / input / entity / serializer / migration parity concerns | `contract-parity-enforcer` | `schema-surface-parity-auditor` |
| entity / migration / table / column with uncertain product surfacing | `schema-surface-parity-auditor` | `data-readback-auditor`, `table-grid-auditor`, `chart-widget-auditor` |
| workflow states, approvals, archive/restore/retry transitions | `workflow-state-auditor` | `button-action-auditor`, `list-visibility-auditor` |
| cache, query invalidation, list/detail refresh | `list-visibility-auditor` | `data-readback-auditor`, `realtime-sync-auditor` |
| tenant-scoped CRUD, cache, events, exports, mobile storage | `tenant-isolation-auditor` | `access-boundary-auditor`, `mobile-app-auditor` |
| `**/a11y/**`, `**/*.a11y.spec.ts`, component diff with `aria-*` / `role=` / keyboard-handler changes | `accessibility-auditor` | `frontend-expert`, `ui-action-mapper` |
| `sens-api-gateway/**` + `sensorprotocols/**` + PLC/SCADA/Modbus/OPC-UA command paths | `edge-industrial-auditor` | `edge-expert`, `sensor-expert` |
| `apps/billing-service/**`, `web/modules/tenant-admin/src/billing/**`, Stripe-backed invoice/payment/refund roundtrips | `billing-reconciliation-auditor` | `billing-expert`, `tenant-isolation-auditor` |
| `apps/*/src/**/webhooks/**`, Stripe/SendGrid/Twilio inbound handler paths | `webhook-ingress-auditor` | `auth-security-expert`, `billing-expert` |
| `apps/*/src/**/jobs/**`, `platform/libs/outbox/**`, Bull/BullMQ/Nest Scheduler consumers | `job-queue-auditor` | `data-expert`, `observability-expert` |

## Dispatch bullets — which auditor for which concern

- `ui-action-mapper` for UI surface inventory
- `mobile-app-auditor` for AquaMobil-specific offline and mobile interaction audits
- `button-action-auditor` for non-trivial button behavior and action wiring
- `form-write-auditor` for UI to API to DB write paths
- `data-readback-auditor` for DB to API to UI read-back paths
- `contract-parity-enforcer` for UI/DTO/entity mismatch risk
- `schema-surface-parity-auditor` for UI-without-DB and DB-without-UI detection
- `access-boundary-auditor` for roles, guards, permissions, feature flags, and impersonation gates
- `table-grid-auditor` for table, grid, filter, sort, pagination, row-action, and export behavior
- `chart-widget-auditor` for KPI, widget, chart, dashboard, and drill-down truthfulness
- `file-transfer-auditor` for upload/import/export/download/attachment flows
- `realtime-sync-auditor` for polling, live refresh, SSE, notifications, sync, and status progression
- `tenant-isolation-auditor` for tenant boundaries across the roundtrip
- `workflow-state-auditor` for lifecycle transitions and state-gated actions
- `list-visibility-auditor` for list/detail/query-cache visibility after writes
- `accessibility-auditor` for keyboard reachability, focus management, ARIA semantics, and assistive-tech operability
- `edge-industrial-auditor` for Rust edge gateway, PLC/SCADA command paths, offline queues, safe-state fallbacks
- `billing-reconciliation-auditor` for invoice/payment/refund/subscription roundtrips and operator-visible Stripe truth
- `webhook-ingress-auditor` for inbound webhook source auth, raw-body integrity, replay/dedup protection, tenant routing
- `job-queue-auditor` for queued/scheduled/retried/dead-lettered work and async idempotency
