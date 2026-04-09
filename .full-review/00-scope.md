# Review Scope

## Target

Farm domain real-time visibility pipeline — end-to-end slice from event publication
(farm-service handlers → transactional outbox → NATS JetStream) through delivery
(gateway-api bridge → Socket.IO gateway) to frontend consumption (React Query
cache invalidation hook). This is the cross-cutting surface added/modified during
the Phase 0-E rollout (`b36806b3`, `ad18d905`, `c98ed579`, `704d2716`, `47424468`,
`ce7b11d3`, `4356a072`) to solve the platform owner's "işlemler anlık görünmüyor"
complaint.

The review scope includes the 16 primary files plus any siblings they directly
import. Pre-existing code touched only tangentially (entity decorators, helper
functions called by the handlers) is referenced but not deeply audited.

## Files

### Backend — Transactional outbox library
- `platform/libs/outbox/` — shared library (constants, entity base, publisher,
  worker, metrics, module, barrel export)

### Backend — Farm service handlers (Phase A + D refactor)
- `apps/farm-service/src/batch/handlers/` — 7 handlers refactored to outbox
  (create-batch, record-cull, record-mortality, transfer-batch, update-batch-status,
  allocate-to-tank, close-batch) plus cleaner-fish handlers for parity
- `apps/farm-service/src/feeding/handlers/` — create-feeding-record (outbox + TOCTOU fix)
- `apps/farm-service/src/harvest/handlers/` — create-harvest-record (contract alignment)

### Backend — Farm outbox wiring
- `apps/farm-service/src/outbox/` — FarmOutbox entity + FarmOutboxModule (Global)
- `apps/farm-service/src/common/utils/reason-codecs.ts` — enum normalization helpers

### Backend — Gateway real-time bridge
- `apps/gateway-api/src/websocket/farm.gateway.ts` — `/farms` namespace + JWT auth + Prom metrics
- `apps/gateway-api/src/websocket/farm-nats-bridge.service.ts` — NATS wildcard subscriber
- `apps/gateway-api/src/websocket/websocket.module.ts` — wiring

### Shared contracts
- `libs/event-contracts/src/farm-events.ts` — CullRecordedEvent + enum const arrays

### Frontend — farm-module
- `web/modules/farm-module/src/hooks/useFarmRealtimeStream.ts` — Socket.IO client + cache invalidation
- `web/modules/farm-module/src/Module.tsx` — hook mount point
- `web/modules/farm-module/src/pages/production/types/batch.types.ts` — enum case alignment
- `web/modules/farm-module/src/pages/production/components/MortalityModal.tsx` — cast removal
- `web/modules/farm-module/src/pages/production/components/CullModal.tsx` — cast removal
- `web/modules/farm-module/vite.config.ts` — Module Federation singleton pin

## Flags

- Security Focus: **yes** (multi-tenant isolation, JWT auth on /farms namespace, NATS subject routing)
- Performance Critical: **yes** (outbox worker polling, bridge subscription fan-out, React Query invalidation)
- Strict Mode: **no**
- Framework: NestJS 10+ (backend), React 18 + Vite + Module Federation (frontend), TypeScript strict

## Review Phases

1. Code Quality & Architecture
2. Security & Performance
3. Testing & Documentation
4. Best Practices & Standards
5. Consolidated Report

## Architectural Context for Reviewers

The pipeline implements a **transactional outbox pattern**: domain handlers INSERT
the event row into `farm_outbox` inside the same DB transaction that performs the
domain write. A worker polls every second and publishes to NATS JetStream with the
tenant-scoped subject pattern `events.{tenantId}.{eventType}`. The gateway bridge
subscribes via `events.*.{eventType}` core NATS wildcards (JetStream messages reach
core subscribers) and broadcasts to Socket.IO rooms keyed by `tenant:{tenantId}`.
The frontend hook invalidates React Query cache prefixes on event arrival so
mutations appear instantly in the UI of any connected client of the same tenant.

Key architectural invariants to check:
- Every outbox enqueue happens BEFORE `commitTransaction()` in the same transaction
- Every broadcast targets ONLY the `tenant:{tenantId}` room (no cross-tenant leakage)
- Every handler uses `OutboxPublisher` (not `@Optional() eventBus` or `DomainEventPublisher`)
- Every event payload matches its contract exactly (no drift like `transferReason` vs `reason`)
- Reconnect paths in the NATS bridge drain stale subscriptions before resubscribing
