# Platform Event-Reliability & Outbox SSoT — Code-Only Audit (2026-06-24)

Owner: platform-kernel-expert (cross-domain; per-finding owners noted)
Method: code-only validation across `apps/*`, `libs/*`, `platform/libs/*`. Three independent validators + targeted reads. Stale in-service docs ignored.

## Context

The platform's event-reliability infrastructure is mature and correct — NATS **JetStream** (durable consumers, explicit ACK, `msgID=eventId` + a `duplicate_window`), a mature `@platform/outbox` (lease relay, backoff, DLQ, idempotency-key, LISTEN/NOTIFY), and a canonical producer recipe in hr-service `clock-in.handler.ts:317` (`outboxPublisher.enqueue(event, manager)` inside the write transaction, then commit). The defect is **uneven adoption**: several services bypass their own outbox and publish domain events directly (dual-write / fire-and-forget), so a crash or NATS gap between commit and publish silently drops the event. Remediation = make the correct pattern mandatory, service by service.

The architectural rule violated throughout: *a state-change that emits a domain event MUST enqueue that event into the transactional outbox on the same EntityManager as the write* (CLAUDE.md Architectural Approach — root-cause, tier-1 "make it impossible"; the in-repo SSoT recipe is hr clock-in / CRITICAL-002).

---

## BILLING-CRITICAL-001

**Title:** billing money handlers commit the financial write then fire-and-forget the domain event via `eventBus?.publish()`, losing PaymentReceived / InvoiceCreated / refund / subscription events on any NATS gap.

**Owner:** billing-expert · **Severity:** CRITICAL · **Layer:** 2

billing-service has a `BillingOutboxModule` (`apps/billing-service/src/outbox/billing-outbox.module.ts`, `@Global`, imported at `app.module.ts:161`) but the money handlers never use it. Each commits the domain write and then publishes directly inside a swallowing try/catch:

- `apps/billing-service/src/billing/handlers/record-payment.handler.ts:148` — `await this.eventBus?.publish(event)` after `manager.save(Payment)` / `manager.save(Invoice)`.
- `apps/billing-service/src/billing/handlers/create-invoice.handler.ts` — same shape.
- `apps/billing-service/src/billing/handlers/refund-payment.handler.ts` — same shape.
- `apps/billing-service/src/billing/handlers/change-subscription-plan.handler.ts` — two events, same shape.
- `apps/billing-service/src/billing/handlers/cancel-subscription.handler.ts` — same shape.

**Risk:** A crash or broker outage between commit and publish silently drops a *financial* event — downstream notification, reconciliation, and revenue analytics never fire, and the payment row exists with no event trail.

**Fix:** Enqueue the event via `OutboxPublisher.enqueue(event, manager)` on the same transactional manager so the event row commits atomically with the write; enqueue failure rolls the financial operation back rather than committing eventless.

---

## SENSOR-CRITICAL-001

**Title:** sensor-service reading/parent-routing events are published fire-and-forget (`.catch()`-swallowed, behind a circuit breaker) instead of via its transactional outbox — and alert-engine consumes `SensorReading` event-driven, so a lost event is a missed life-safety alert.

**Owner:** sensor-expert · **Severity:** CRITICAL · **Layer:** 2

`apps/sensor-service/src/sensor/services/sensor-ingestion.service.ts:226` (`this.publishReadingEvent(saved).catch(...)`) and `:398-405` (`publishParentRoutingEvent(...).catch(...)`) publish via `eventBus.publish` (circuit-breaker wrapped) AFTER the reading is persisted, swallowing failures; the service has an unused outbox module. `publishReadingEvent` emits `SensorReading` (dissolvedOxygen/ph/ammonia/…) at `:585-603`.

**Decision (2026-06-24): make it durable via the outbox — best-effort is ruled out.** Verified that `apps/alert-engine/src/alert/event-handlers/sensor-reading.handler.ts` (`SensorReadingEventHandler`) consumes the `SensorReading` event and invokes `AlertEvaluationService.evaluateSensorReading`. Alert evaluation is **event-driven, not DB-polling**, so a dropped `SensorReading` event (NATS outage / open circuit / crash-after-save) silently skips alert evaluation for that reading — a missed life-safety alert (e.g. dissolved-oxygen crash), even though the reading row persists. Durability therefore outranks the per-reading outbox write-amplification cost. If volume becomes a problem, batch the outbox enqueue — do not revert to fire-and-forget.

**Fix (own focused PR — hottest path, single + batch ingestion + circuit-breaker/retry interplay; not bundled with billing):** persist the reading and enqueue `SensorReading` on the same transactional manager via the sensor outbox; apply the same to the batch ingestion path and the parent-routing event. Open topology question to confirm during that PR: whether the Rust `sensor-ingestion` sidecar (already outbox-durable) is the primary high-throughput path and this NestJS path is secondary — which would bound the write-amplification surface.

---

## ALERT-CRITICAL-001

**Title:** alert-engine publishes AlertTriggered / AlertResolved / AlertEscalated directly (best-effort try/catch) with no transactional outbox; a dropped AlertTriggered silently fails operator notification of a life-safety condition.

**Owner:** alert-engine-expert · **Severity:** CRITICAL · **Layer:** 2

`apps/alert-engine/src/alert/services/alert-evaluation.service.ts:443` (AlertTriggered, emitted after `historyRepository.save` :313 and `incidentRepository.save` :408) and `:547` (AlertResolved, after `incidentRepository.save` :542), plus `apps/alert-engine/src/escalation/escalation-manager.service.ts:383` (AlertEscalated), call `eventBus.publish()` inside a swallowing `try/catch`. `AlertTriggered` is consumed by `apps/notification-service/src/notification/event-handlers/alert-triggered.handler.ts`, which dispatches operator SMS/email/push — so a publish dropped after the incident commits leaves the incident persisted but the operator **never notified** of a dangerous condition (e.g. dissolved-oxygen crash). `AlertOutboxModule` is wired (`app.module.ts:161`) but unused. **Severity raised HIGH→CRITICAL:** this is the operator-notification path for life-safety alerts, equivalent in consequence to SENSOR-CRITICAL-001 (verified consumer, not merely "life-safety-adjacent").

**Fix:** Enqueue AlertTriggered / AlertResolved / AlertEscalated via the alert outbox on the **same EntityManager** as the history/incident write (atomic save+enqueue); remove the best-effort `try/catch` so a failed enqueue rolls the write back rather than committing an un-notified incident.

---

## ADMIN-HIGH-003 (RE-SCOPED — not an outbox conversion)

**Title:** admin-api tenant↔module assignment publishes ModuleAssignedToTenant / ModuleRemovedFromTenant to the in-process `@nestjs/cqrs` EventBus — no NATS bridge, no subscriber anywhere — so the events are dead, not merely volatile.

**Owner:** admin-expert · **Severity:** HIGH (re-classified — correctness / dead-code, not durability) · **Layer:** 2

**CORRECTION to the original finding (evidence-based, 2026-06-24):** `apps/admin-api-service/src/modules/tenant-management/services/module-assignment.service.ts:289,470` inject `EventBus` from `@nestjs/cqrs` (the **in-process** bus), NOT `@platform/event-bus` `IEventBus`/`NatsEventBus`. admin-api registers a plain `CqrsModule.forRoot()` with no `IEventPublisher`→NATS bridge, and a repo-wide search finds **zero subscribers** for `ModuleAssignedToTenant` / `ModuleRemovedFromTenant`. Tenant provisioning is already driven synchronously via `authProvisioningClient.removeTenantModule`/add, and the audit row via `createAuditLog` — so these publishes reach no handler and cross no service boundary. Routing them through the outbox would only move dead events onto NATS where nothing consumes them — **not** a root-cause fix, and the original "wrap write + outbox enqueue" fix was based on the incorrect assumption that these were NATS publishes.

**Fix (architectural decision required — escalated, deliberately NOT done in this PR):** Either (a) delete the vestigial in-process publishes (the synchronous provisioning call + audit-log already cover the side effects), or (b) if a consumer is intended (e.g. billing recompute on module change), define that consumer and cross to NATS via the outbox. Pending owner decision.

---

## FARM-MEDIUM-074

**Title:** farm task.create and recurring-task generation publish directly (create outside tx; recurring inside-tx-after-save TOCTOU) while task.update already uses the outbox.

**Owner:** farm-expert · **Severity:** MEDIUM · **Layer:** 2

`apps/farm-service/src/task/services/task.service.ts:162` publishes after save outside the transaction; `apps/farm-service/src/task/services/recurring-task.service.ts:234` publishes inside the tx but after save (crash-between-save-and-commit loses the event). `task.update` already enqueues to the outbox correctly — the inconsistency is the defect. (The mortality/harvest listeners are reactive follow-up emitters and are correct; not in scope.)

**Fix:** Enqueue create + recurring-generation events via the farm outbox on the write transaction's manager.

---

## HR-MEDIUM-001

**Title:** hr-service scheduling (shifts) publish-weekly-plan still notifies fire-and-forget while attendance, payroll, and leave were remediated to the outbox.

**Owner:** hr-expert · **Severity:** MEDIUM · **Layer:** 2

`apps/hr-service/src/scheduling/handlers/publish-weekly-plan.handler.ts:58-67` calls the notification service fire-and-forget with a swallowing `.catch()`; the other hr modules use the outbox (e.g. attendance `clock-in.handler.ts:317`).

**Fix:** Route the shift-publish domain event through the hr outbox.
