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

**Title:** sensor-service reading/parent-routing events are published fire-and-forget (`.catch()`-swallowed) instead of via its transactional outbox, risking lost critical telemetry events.

**Owner:** sensor-expert · **Severity:** CRITICAL · **Layer:** 2

`apps/sensor-service/src/sensor/services/sensor-ingestion.service.ts:226` (`this.publishReadingEvent(saved).catch(...)`) and `:398` (`this.publishParentRoutingEvent(...).catch(...)`) publish directly and swallow failures; the service has an outbox module that is unused. (Telemetry rows persist correctly; the *event* propagation is the gap.)

**Fix:** Route these domain events through the sensor outbox on the persisting transaction's manager.

---

## ALERT-HIGH-001

**Title:** alert-engine publishes AlertTriggered / AlertResolved directly with no transactional outbox and no documented best-effort rationale.

**Owner:** alert-engine-expert · **Severity:** HIGH · **Layer:** 2

`apps/alert-engine/src/alert/services/alert-evaluation.service.ts:443` (AlertTriggered) and `:546` (AlertResolved) call `eventBus.publish()` directly; the outbox module exists but is unused, and there is no comment marking the publish as intentionally volatile. For life-safety-adjacent alerts the default must be durable.

**Fix:** Enqueue via the alert outbox, or — if a class of alert is deliberately volatile — mark it on an explicit, commented volatile-allowlist.

---

## ADMIN-HIGH-003

**Title:** admin-api tenant↔module assignment publishes ModuleRemovedFromTenant / TenantModulesAssigned directly; loss desynchronises tenant provisioning.

**Owner:** admin-expert · **Severity:** HIGH · **Layer:** 2

`apps/admin-api-service/src/modules/tenant-management/services/module-assignment.service.ts:289,470` publish reference-data lifecycle events directly after non-transactional writes; the outbox module is unused.

**Fix:** Wrap the assignment write + outbox enqueue in one transaction.

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
