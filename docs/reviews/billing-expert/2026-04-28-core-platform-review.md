# billing-expert — review — 2026-04-28 — core-platform-review

## Scope

Full CATCHER review of `apps/billing-service/**` (86 TS files, ~21K LoC) plus the
delegated plan-tier enforcement slice in
`apps/gateway-api/src/middleware/tenant-context.middleware.ts` and
`apps/gateway-api/src/services/tenant-lookup.service.ts`. Branch: `main` @
`a958dc66`. Working tree clean. Surfaces inspected: Stripe webhook ingress
(controller + service), subscription saga (CreateSubscriptionHandler,
ChangeSubscriptionPlanHandler, CancelSubscriptionHandler, RefundPaymentHandler),
tenant-subscription-requested NATS handler, billing scheduler (trial expiry,
expiry, overdue, monthly invoice generation, scheduled plan change apply),
metering subsystem (UsageMeteringService + UsageAggregatorService +
MeteredBillingService), entities (Subscription, Invoice, Payment, Plan,
TenantUsageMetrics), monetary primitives (`MoneyColumn` /
`DecimalValueTransformer`), and gateway-side PLAN_LIMITS.

## Executive summary

The billing surface is structurally well-organised (CQRS handlers, Money + Decimal
discipline at the row level, raw-body Stripe signature verification, transactional
write paths with pessimistic locks, scheduler with advisory locks, retry queue
for the auth→billing provisioning saga). However it carries **five
revenue-critical architectural defects** that together make the service unfit
for production billing as currently shaped:

1. **No Stripe SDK / no outbound Stripe API integration anywhere in the
   workspace** — the webhook receives events but the system cannot create
   subscriptions, charge cards, or process refunds via Stripe. The "PIVOT"
   step in the subscription/refund saga simply does not exist (BILLING-CRITICAL-001).
2. **`PLAN_LIMITS` is dead code** — `getTenantLimit()` is exported but only
   tests call it. Zero production callsite enforces `maxFarms`, `maxPonds`,
   `maxSensors`, `maxStorageGb`, `maxApiRequests`, or `maxUsers` on resource-creation
   paths. Tenants on starter ($49) can create unlimited everything (BILLING-CRITICAL-002).
3. **Metered counters mutate in-process** with periodic 10-second Redis
   sync — non-atomic `meter.currentValue += event.quantity` plus crash-window
   loss between syncs. Direct violation of the agent invariant requiring atomic
   Redis Lua INCR (BILLING-CRITICAL-003).
4. **No persistent dedup layer for Stripe webhook events** — only Redis
   `SETNX EX 72h`; if Redis flushes or the 72h TTL expires, replays double-process
   payments and refunds (BILLING-HIGH-001).
5. **Subscription/Plan pricing stored as `Float` inside `jsonb`** — bypasses
   the Money/numeric(19,4) discipline that the rest of the row uses. `DEFAULT_PRICING`
   in the NATS handler also passes raw `number` into the saga (BILLING-HIGH-002).

Verdict: **BLOCK**. The CRITICALs are revenue-loss class and structural — they
cannot be patched at handler level; they require a Stripe SDK adoption decision
(arbiter-level, security-reviewer pair-review) and a plan-limit enforcement
guard at every resource-creation handler.

## Findings (by severity)

### CRITICAL

#### BILLING-CRITICAL-001 — No Stripe SDK / no outbound Stripe API; saga PIVOT step is fictional

**Severity:** CRITICAL
**Layer:** 2 (saga compensation pattern) + 3 (agent ownership invariant)
**State:** OPEN
**Sub-kind:** SAGA_PIVOT

**Evidence**
- `package.json` — no `stripe` or `@stripe/*` dependency in any workspace package.
- `apps/billing-service/src/billing/handlers/create-subscription.handler.ts:103-137` — creates a row with `stripeCustomerId` from input but never calls Stripe to create a Subscription; `stripeSubscriptionId` remains null.
- `apps/billing-service/src/billing/handlers/refund-payment.handler.ts:24-94` — mutates `payment.refundedAmount` and `payment.status` but **never calls `stripe.refunds.create`**. Internal state diverges from Stripe.
- `apps/billing-service/src/billing/handlers/change-subscription-plan.handler.ts:137-200` — upgrade/downgrade modifies internal `subscription.pricing` but never updates Stripe Subscription items.
- `apps/billing-service/src/billing/billing-scheduler.service.ts:225-407` — generates internal Invoice rows monthly but never calls `stripe.invoices.create` / `stripe.invoices.finalizeInvoice`. Customer is never billed.
- `apps/billing-service/src/billing/controllers/stripe-webhook.service.ts` — only direction of integration is **inbound** (we receive Stripe events). There is no outbound counterpart anywhere in the repo.

**Rule violated**
- Agent invariant *Subscription saga + state machine — PIVOT step = Stripe subscription creation/cancellation* (`.claude/agents/billing-expert.md:62`). The PIVOT does not exist.
- Agent invariant *Refund flow: full refund within 30d → cancel subscription; partial refund → adjust next-period invoice* (`.claude/agents/billing-expert.md:73`). Refund handler never reaches Stripe.
- Layer-2 *Saga compensation* (`.claude/knowledge/layer-2-patterns.md:53-56`) — compensation requires verification against an external SoT; absent here.

**Proposed fix direction**
- Adopt the official `stripe` Node SDK (`stripe@^16` against the API version
  pinned in a constants file; pair-review by security-reviewer because of
  financial regulation surface).
- Introduce a `StripeApiClient` provider in `libs/backend-common` (or a new
  `apps/billing-service/src/stripe/` module) constructed via secrets-provider
  (`STRIPE_SECRET_KEY` already in `PLATFORM_SECRET_ENV_VARS`).
- Refactor `CreateSubscriptionHandler` and `TenantSubscriptionRequestedHandler`
  into a true two-phase saga: pre-pivot DB row in `PENDING` → call
  `stripe.customers.create` + `stripe.subscriptions.create` → on success persist
  `stripeSubscriptionId` and transition to `TRIAL`/`ACTIVE`; on failure compensate
  by deleting the local row.
- Refund / cancel / change-plan handlers MUST drive Stripe before mutating
  internal state.

**Affected surface (ripple set)**
- `apps/billing-service/src/billing/handlers/{create-subscription,cancel-subscription,refund-payment,change-subscription-plan}.handler.ts`
- `apps/billing-service/src/billing/billing-scheduler.service.ts`
- `apps/billing-service/src/billing/event-handlers/tenant-subscription-requested.handler.ts`
- New module: `apps/billing-service/src/billing/stripe/stripe-api.service.ts`
- `package.json` (add `stripe` dep)
- `apps/billing-service/src/billing/__tests__/*.spec.ts` (mock the new service)

**Expected closer**
architectural-arbiter ruling on Stripe API adoption + security-reviewer pair-review,
then `implementation-planner` skill-DAG composing the change. This is too large
for billing-expert WRITER mode in a single cycle.

---

#### BILLING-CRITICAL-002 — `PLAN_LIMITS` dead code: zero enforcement of tier caps in resource-creation paths

**Severity:** CRITICAL
**Layer:** 3 (delegated invariant from multi-tenant-saas-expert MT-HIGH-002 — escalated)
**State:** OPEN
**Sub-kind:** PLAN_LIMIT_GAP

**Evidence**
- `apps/gateway-api/src/middleware/tenant-context.middleware.ts:187-233` defines `PLAN_LIMITS` with 6 caps (`maxUsers`, `maxFarms`, `maxPonds`, `maxSensors`, `maxApiRequests`, `maxStorageGb`).
- `apps/gateway-api/src/middleware/tenant-context.middleware.ts:561` exports `getTenantLimit(limit)`.
- `grep -rn "getTenantLimit(" apps/ libs/ web/ platform/` returns ONLY the function declaration site and **two test files** (`apps/gateway-api/src/interceptors/__tests__/tenant-context.interceptor.spec.ts:687-704`, `apps/gateway-api/src/middleware/__tests__/tenant-context.middleware.spec.ts:565-574`). No production callsite exists in `apps/farm-service`, `apps/sensor-service`, `apps/auth-service`, `apps/hr-service`, etc.
- `grep -rn "limits\.max" apps/farm-service/src apps/sensor-service/src` returns **zero** non-test matches relevant to plan caps.
- The starter plan has `maxFarms: 1` declared, but the `CreateFarm` command in `apps/farm-service` performs no count check before persist.
- Same gap on `CreatePond`, `RegisterSensor`, user/seat creation, storage allocation, API request rate.

**Rule violated**
- Agent invariant *Plan-tier enforcement — every resource-creation command MUST read tenant's planLevel + check resource count against limit BEFORE persist* (`.claude/agents/billing-expert.md:76-77`).
- Tier-1 architectural goal (`make impossible`) — currently violated at Tier-4 (documented ceiling, no enforcement). This is the worst-of-tier scenario: limit values are visible in code so a customer can ask "why am I not capped?" and the answer is "because nobody wrote the check".

**Proposed fix direction**
- Tier-1 candidate: brand a `EnforcedPlanLimit<K>` type and require any resource-creation command to consume it via a `PlanLimitGuard` interceptor that fails 429 `PLAN_LIMIT_EXCEEDED` before the command bus sees the command.
- Tier-3 fallback: write a CI invariant (`tests/invariants/plan-limit-enforcement.spec.ts`) that asserts every `Create*Command` handler imports + invokes `enforcePlanLimit(...)`. Couple to a `.claude/skills/add-resource-creation-command` skill.
- Plan-downgrade safety: `ChangeSubscriptionPlanHandler` MUST also call the same enforcer to verify current usage ≤ new plan's limit BEFORE the downgrade is scheduled — currently scheduled blindly (`apps/billing-service/src/billing/handlers/change-subscription-plan.handler.ts:150-188`).

**Affected surface (ripple set)**
- `apps/farm-service/src/farm/handlers/create-farm.handler.ts`, `apps/farm-service/src/pond/handlers/create-pond.handler.ts`
- `apps/sensor-service/src/sensor/handlers/register-sensor.handler.ts`
- `apps/auth-service/src/users/handlers/create-user.handler.ts`
- `apps/hr-service/src/employee/handlers/*.handler.ts`
- `apps/billing-service/src/billing/handlers/change-subscription-plan.handler.ts`
- New: `libs/backend-common/src/billing/plan-limit-guard.ts`

**Expected closer**
multi-tenant-saas-expert (contract owner) + billing-expert WRITER mode pair (enforcement owner)
via `implementation-planner` skill-DAG. Also flag for security-reviewer (revenue + abuse surface).

---

#### BILLING-CRITICAL-003 — Metered counter increment is non-atomic + crash-loses up to 10s of usage

**Severity:** CRITICAL
**Layer:** 1 (Redis primitive misuse) + 2 (revenue-correctness invariant)
**State:** OPEN
**Sub-kind:** METER_RACE

**Evidence**
- `apps/billing-service/src/modules/metering/usage-metering.service.ts:521-547` — `processEvent()`:
  ```
  meter.currentValue += event.quantity;
  meter.eventCount++;
  ...
  this.dirtyTenants.add(event.tenantId);
  ```
  Pure JS-object mutation. No INCR, no Lua, no SETEX.
- `apps/billing-service/src/modules/metering/usage-metering.service.ts:185-202` — `flushInterval` 5s buffer flush, `redisWriteInterval` 10s sync. Crash between syncs loses every event since the last sync.
- `apps/billing-service/src/modules/metering/usage-metering.service.ts:296-346` — `syncToRedis()` does a **whole-state JSON `setJson`** per tenant; it overwrites whatever Redis holds. Two service replicas running concurrently will silently overwrite each other's increments (last-write-wins).
- No `INCRBY` / `HINCRBY` calls anywhere in the codebase: `grep -n "INCRBY\|HINCRBY" apps/billing-service/src/**/*.ts` returns 0.
- `apps/billing-service/src/modules/metering/usage-aggregator.service.ts:440-446` repeats the same pattern — `aggregation.totalUsage += quantity` in-memory, periodic 30s DB upsert.

**Rule violated**
- Agent invariant *Metered counter increment MUST be atomic via Redis Lua INCRBY + EXPIRE pair* (`.claude/agents/billing-expert.md:53`). Direct violation.
- Layer-1 *Rate limiting / atomic Redis* pattern (`.claude/knowledge/layer-1-nestjs.md:69`) — Lua-script atomic INCR, fail closed.
- This compounds with multi-replica deployment: revenue-leak proportional to (number of replicas × events between syncs).

**Proposed fix direction**
- Tier-1: replace `processEvent` with a single Lua script that atomically INCRBY `meter:{tenantId}:{meterType}:current` AND HINCRBY a hash with the event count + maintains the per-period TTL. Local in-memory state becomes a read-cache only, sourced from Redis.
- DB persistence becomes a periodic snapshot from Redis to `tenant_usage_metrics` (the canonical billable record), driven by a single advisory-locked cron — never a per-replica timer.
- Once Stripe SDK lands (BILLING-CRITICAL-001), drive Stripe Meter API events on every Redis INCRBY response so the platform's authoritative usage state matches Stripe's (also closes the agent invariant in `billing-expert.md:54` requiring Stripe Meter + MeterEvent API, not legacy `usage_records`).

**Affected surface (ripple set)**
- `apps/billing-service/src/modules/metering/usage-metering.service.ts` (full rewrite of state model)
- `apps/billing-service/src/modules/metering/usage-aggregator.service.ts`
- `apps/billing-service/src/modules/metering/__tests__/*.spec.ts`
- New: `apps/billing-service/src/modules/metering/redis/meter-counter.lua` + loader

**Expected closer**
billing-expert WRITER mode after `implementation-planner` package, paired with
auth-security-expert for the Lua-script review (atomic semantics + TTL semantics +
multi-replica safety).

---

### HIGH

#### BILLING-HIGH-001 — Stripe webhook dedup has no persistent layer; Redis-only is replay-unsafe

**Severity:** HIGH
**Layer:** 2 (idempotency invariant)
**State:** OPEN (matches inherited finding from `platform-services.md:Phase-8.4`)
**Sub-kind:** WEBHOOK_DEDUP

**Evidence**
- `apps/billing-service/src/billing/controllers/stripe-webhook.controller.ts:138-150` — only Redis `setNx(key, ts, 72h)` dedup. `RedisService` is `@Optional()` (line 72) — if not configured, **no dedup at all** runs.
- No `billing.stripe_webhook_events(event_id PK, ...)` table or migration.
- The 72h TTL means any Stripe event replayed from their dashboard or via their `Resend` admin-tool >72h after first delivery will be **double-processed**.
- The downstream service handlers (`stripe-webhook.service.ts:71-184`) DO have DB-level secondary idempotency for `payment_intent.succeeded` (existingPayment guard) and `payment_intent.payment_failed` (existingFailed guard, lines 220-229), so the worst case is bounded for those two events. But `customer.subscription.deleted` and `charge.refunded` rely on idempotent state-machine transitions only — replay of `charge.refunded` on a partially-refunded payment will append a duplicate `RefundInfo` array entry (`stripe-webhook.service.ts:478-480`).

**Rule violated**
- Agent invariant *Idempotency on `event.id` MANDATORY at TWO layers — Layer-1 Redis SETNX EX 72h; Layer-2 persistent table `billing.stripe_webhook_events`* (`.claude/agents/billing-expert.md:43-45`).

**Proposed fix direction**
- Add migration creating `billing.stripe_webhook_events(event_id UUID PK, type, received_at TIMESTAMPTZ, processed_at TIMESTAMPTZ NULL, status VARCHAR, result JSONB)`.
- Insert row in same outbound transaction (or pre-lookup before processing) — uniqueness enforced by PK.
- `setNx` Redis stays as the fast path; DB lookup is the fallback when Redis miss.
- `RedisService @Optional()` should become a hard requirement: `redisService` injection MUST not be optional on a webhook controller — fail-closed pattern (BILLING-MEDIUM-001 below tracks the optional-injection issue separately for cleanliness).

**Affected surface (ripple set)**
- New migration `apps/billing-service/src/database/migrations/<ts>-AddStripeWebhookEventsTable.ts`
- New entity `apps/billing-service/src/billing/entities/stripe-webhook-event.entity.ts`
- `apps/billing-service/src/billing/controllers/stripe-webhook.controller.ts`
- `apps/billing-service/src/billing/billing.module.ts` (register entity)

**Expected closer**
billing-expert WRITER mode + data-expert CATCHER (migration pattern review).

---

#### BILLING-HIGH-002 — Subscription / Plan pricing stored as `Float` in jsonb bypasses Money discipline

**Severity:** HIGH
**Layer:** 1 (TypeORM column type discipline) + 2 (monetary precision pattern)
**State:** OPEN
**Sub-kind:** INVOICE_PRECISION

**Evidence**
- `apps/billing-service/src/billing/entities/subscription.entity.ts:74-89` — `PlanPricing` ObjectType uses `@Field(() => Float)` for `basePrice`, `perFarmPrice`, `perSensorPrice`, `perUserPrice`.
- `subscription.entity.ts:130-131` — `@Column('jsonb') pricing!: PlanPricing` — stores those Floats inside a jsonb blob, no precision constraint.
- `apps/billing-service/src/billing/entities/plan.entity.ts:62-67` — Plan duplicates the same jsonb (`pricing!: PlanPricing`) ALONGSIDE a properly typed `@MoneyColumn() basePrice!: Decimal` (line 50-51). Two sources of truth with different precision semantics — silent drift between them is unrecoverable.
- `apps/billing-service/src/billing/event-handlers/tenant-subscription-requested.handler.ts:119-143` — `DEFAULT_PRICING` is `Record<string, { basePrice: number; ... }>`. Raw `number` flows into `CreateSubscriptionCommand` and persists as Float.
- `apps/billing-service/src/modules/metering/metered-billing.service.ts:704-714, 1275-1277` — entire pricing engine operates on `number` (e.g. `subtotalBeforeTax * (taxConfig.rate / 100)` followed by `Math.round(amount * 100) / 100`). For VAT 18% on $99.99 base + $0.001/call usage, IEEE-754 drift surfaces inside ~1000 invoice cycles.

**Rule violated**
- Agent invariant *Every monetary column MUST be `@Column({ type: 'numeric', precision: 14, scale: 4, transformer: DecimalTransformer })`* (`.claude/agents/billing-expert.md:68`).
- Agent invariant *Currency MUST be ISO 4217 3-letter code stored as `@Column({ type: 'char', length: 3 })`* (`.claude/agents/billing-expert.md:69`). Subscription/Invoice/Payment use plain `varchar` defaults instead.
- Layer-1 *MoneyColumn pattern* (`libs/backend-common/src/monetary/decimal-column.decorator.ts:89-109`).

**Proposed fix direction**
- Promote `Plan.basePrice` (already MoneyColumn) to be the canonical source; remove the `pricing!: PlanPricing` jsonb on Plan and on Subscription (Subscription should reference plan + override columns explicitly typed).
- New columns on Subscription: `base_price_amount NUMERIC(19,4)`, `per_farm_price NUMERIC(19,4)`, `per_sensor_price NUMERIC(19,4)`, `per_user_price NUMERIC(19,4)`, `currency CHAR(3)`. Migrate jsonb data via blue-green 3-step.
- `MeteredBillingService` rewrite to consume `Money` / `Decimal` end-to-end. Round-on-output, never round-mid-pipeline.
- Add a custom GraphQL `Decimal` scalar (the `PLAT-LOW-001` TODO in `invoice.entity.ts:39-42` already names it) — promote from LOW to HIGH because of compounding effect.

**Affected surface (ripple set)**
- `apps/billing-service/src/billing/entities/{subscription,plan,scheduled-plan-change}.entity.ts`
- `apps/billing-service/src/billing/handlers/{create-subscription,change-subscription-plan}.handler.ts`
- `apps/billing-service/src/billing/event-handlers/tenant-subscription-requested.handler.ts` (DEFAULT_PRICING typing)
- `apps/billing-service/src/modules/metering/metered-billing.service.ts`
- `apps/billing-service/src/billing/billing-scheduler.service.ts:285-340` (consume Money)
- New migration set (3-step add-nullable / backfill / NOT NULL per ADR-012)
- `libs/backend-common/src/graphql/decimal.scalar.ts` (new)

**Expected closer**
data-expert + billing-expert pair (migration pattern + saga consumer adjustments).

---

#### BILLING-HIGH-003 — In-house tax engine is hand-rolled with hardcoded rates; agent contract requires Stripe Tax API

**Severity:** HIGH
**Layer:** 3 (regulation + audit risk)
**State:** OPEN

**Evidence**
- `apps/billing-service/src/modules/metering/metered-billing.service.ts:471-617` — 19 hardcoded country/state tax rates (`taxRates.set('TR', { rate: 18, ... })`, US state breakdowns, EU VAT, APAC GST). No update mechanism.
- `metered-billing.service.ts:703-711` — hardcoded `taxConfig.rate / 100` arithmetic produces `number` tax amounts.
- Same file lines 622-642 — hardcoded **exchange rates** (USD-EUR, USD-TRY, etc.) initialised once and only refreshed by an internal `updateExchangeRate()` method that no caller invokes. Staleness check throws after 72h (line 1129) — meaning multi-currency billing **breaks open after 3 days uptime** unless someone manually pokes the service.

**Rule violated**
- Agent invariant *Tax calculation deferred to Stripe Tax API (no in-house tax engine). In-house tax computation = HIGH (regulatory burden + audit risk)* (`.claude/agents/billing-expert.md:71`).

**Proposed fix direction**
- Once Stripe SDK lands (BILLING-CRITICAL-001), delegate tax computation to Stripe Tax (`tax: { calculation: ... }` on Subscription / Invoice creation). Remove the `taxRates` map.
- For multi-currency: accept that we bill **only in the customer's plan currency** (set on Subscription at creation, immutable) — never convert at invoice time. Drop the `exchangeRates` map entirely. If the platform actually needs reporting-currency conversion, that is a read-side projection problem, not a billing-engine concern.

**Affected surface (ripple set)**
- `apps/billing-service/src/modules/metering/metered-billing.service.ts` (delete tax + FX subsystems)
- All tests under `apps/billing-service/src/modules/metering/__tests__/`

**Expected closer**
architectural-arbiter ruling (Stripe Tax adoption) → billing-expert WRITER.

---

#### BILLING-HIGH-004 — Webhook signature failures emit no security alert; silent log only

**Severity:** HIGH
**Layer:** 3 (security observability)
**State:** OPEN

**Evidence**
- `apps/billing-service/src/billing/controllers/stripe-webhook.controller.ts:111-115` — `verifySignature` failure path:
  ```
  this.logger.warn(`Webhook signature verification failed: ${verificationResult.reason}`);
  res.status(400).json({ error: 'Invalid signature' });
  ```
- No event published, no NATS security event, no Prometheus counter (`billing_webhook_signature_failures_total`).

**Rule violated**
- Agent invariant *`Webhook signature failed` event MUST emit security alert (potential attack vector). Silent log-only = HIGH* (`.claude/agents/billing-expert.md:48`).

**Proposed fix direction**
- Emit `BillingWebhookSignatureFailed` event via NATS (event-contracts addition; BaseEvent subclass).
- Increment a Prometheus counter via `StructuredLoggerService` / observability-service hook.
- Auth-security-expert pair-review: failed verification on `/webhooks/stripe` is an attacker probing for the secret; escalate to security-event channel.

**Affected surface (ripple set)**
- `libs/event-contracts/src/billing-events.ts` (new event interface)
- `apps/billing-service/src/billing/controllers/stripe-webhook.controller.ts`
- `apps/observability-service/**` (consumer, optional)

**Expected closer**
auth-security-expert + billing-expert pair.

---

#### BILLING-HIGH-005 — Direct `eventBus.publish` inside DB transaction; outbox pattern not adopted

**Severity:** HIGH
**Layer:** 2 (outbox pattern, ADR-006 / DATA-HIGH-004)
**State:** OPEN

**Evidence**
- `apps/billing-service/src/billing/handlers/create-subscription.handler.ts:151-175` — publish AFTER `commitTransaction()`. NATS publish failure is caught and warned. Result: subscription persisted but no event downstream — HR/notification/admin services never see the new tenant.
- `apps/billing-service/src/billing/handlers/cancel-subscription.handler.ts:80-95`, `refund-payment.handler.ts:144-165`, `change-subscription-plan.handler.ts:212-239` — same pattern: publish-after-commit inside try/catch with warn-only.
- `apps/billing-service/src/billing/billing-scheduler.service.ts:360-381, 564-575` — scheduler publishes events with the same warn-and-swallow shape.
- `apps/billing-service/src/billing/controllers/stripe-webhook.service.ts:166-184, 257-276, 404-419` — webhook handlers do publish INSIDE the transaction (good for transactional consistency) but still warn-and-swallow on NATS failure.
- `grep -rn "@platform/outbox" apps/billing-service/src` returns 0 — billing-service does **not** import the outbox library at all.

**Rule violated**
- Layer-2 *Outbox pattern (ADR-006 + platform/libs/outbox) — atomic persist + publish guarantee* (`.claude/knowledge/layer-2-patterns.md:14-19`).
- ADR-006 (`docs/adr/006-event-contracts-flat-pattern.md`) — flat event shape compliant, but transactional outbox unaddressed.
- DATA-HIGH-004 (3/12 services adopted; billing is one of the unadopted nine).

**Proposed fix direction**
- Refactor every `eventBus.publish(...)` callsite in billing-service into `outboxRepo.save(outboxRow)` inside the same transaction.
- Register `@platform/outbox` worker in `app.module.ts`.
- Once landed, the W7 ESLint rule `no-direct-event-publish` (layer-1-nestjs.md:39) protects the surface.

**Affected surface (ripple set)**
- All `apps/billing-service/src/billing/handlers/*.handler.ts` that emit events (10 files)
- `apps/billing-service/src/billing/event-handlers/tenant-subscription-requested.handler.ts`
- `apps/billing-service/src/billing/billing-scheduler.service.ts`
- `apps/billing-service/src/billing/controllers/stripe-webhook.service.ts`
- `apps/billing-service/src/app.module.ts` (register outbox)

**Expected closer**
data-expert (outbox primary owner) + billing-expert pair via implementation-planner.

---

#### BILLING-HIGH-006 — `TenantSubscriptionRequestedHandler` creates DB tables via raw DDL on first failure

**Severity:** HIGH
**Layer:** 3 (ADR-011 + ADR-012 schema discipline)
**State:** OPEN

**Evidence**
- `apps/billing-service/src/billing/event-handlers/tenant-subscription-requested.handler.ts:487-513` — `ensureRetryTable()` runs `CREATE TABLE IF NOT EXISTS billing.subscription_provisioning_retries(...)` at runtime, on first persistForRetry call.
- No corresponding migration in `apps/billing-service/src/database/migrations/`.

**Rule violated**
- ADR-011 (Schema Ownership) — all schema changes go through migrations (`docs/adr/011-schema-ownership-model.md`).
- Layer-1-typeorm *Migration discipline — generator-driven; never hand-edit; always generate a new one* (`.claude/knowledge/layer-1-typeorm.md:23-24`).
- Layer-3 ADR-012 enforcement (drift validator + CI invariant) — runtime DDL bypasses both gates.

**Proposed fix direction**
- Generate a proper migration (`<ts>-AddSubscriptionProvisioningRetriesTable.ts`).
- Add a `SubscriptionProvisioningRetry` entity with `@Entity('subscription_provisioning_retries', { schema: 'billing' })`.
- Replace raw SQL CRUD in `processRetryQueue` and `persistForRetry` with TypeORM repository operations.
- Delete `ensureRetryTable()`.

**Affected surface (ripple set)**
- New migration + new entity
- `apps/billing-service/src/billing/event-handlers/tenant-subscription-requested.handler.ts` (replace raw queries)
- `apps/billing-service/src/billing/billing.module.ts` (register entity)

**Expected closer**
data-expert WRITER mode (migration owner).

---

#### BILLING-HIGH-007 — Plan downgrade does not validate current usage against new plan limits

**Severity:** HIGH
**Layer:** 2 (saga compensation correctness)
**State:** OPEN
**Sub-kind:** PLAN_LIMIT_GAP

**Evidence**
- `apps/billing-service/src/billing/handlers/change-subscription-plan.handler.ts:150-188` — `isDowngrade` branch:
  ```
  // IMPORTANT: Do NOT change subscription fields — current plan stays active
  ```
  No usage check is performed against `newPlan.limits` before scheduling.
- The applied-on-cron path in `billing-scheduler.service.ts:519-585` blindly applies `change.newLimits` without re-checking actual resource counts.

**Rule violated**
- Agent invariant *Plan downgrade MUST check current usage ≤ new plan limits BEFORE Stripe PIVOT. Silent downgrade with feature loss = HIGH* (`.claude/agents/billing-expert.md:78`).

**Proposed fix direction**
- Inject a `UsageQueryPort` (or use multi-tenant-saas-expert's planned plan-limit-guard) at scheduling time AND at apply time.
- If usage > new limits, refuse to schedule and respond `409 USAGE_EXCEEDS_NEW_PLAN_LIMITS` with the offending counters; UI prompts user to reduce usage first.
- Couple to BILLING-CRITICAL-002 (same enforcement surface).

**Affected surface (ripple set)**
- `apps/billing-service/src/billing/handlers/change-subscription-plan.handler.ts`
- `apps/billing-service/src/billing/billing-scheduler.service.ts:applyScheduledPlanChanges`
- New cross-service usage-query API (or read from local TenantUsageMetrics if it's authoritative)

**Expected closer**
multi-tenant-saas-expert + billing-expert pair.

---

### MEDIUM

#### BILLING-MEDIUM-001 — `RedisService` is `@Optional()` on the webhook controller; webhook idempotency degrades to none on misconfiguration

**Severity:** MEDIUM
**Layer:** 2 (fail-closed discipline)
**State:** OPEN

**Evidence**
- `apps/billing-service/src/billing/controllers/stripe-webhook.controller.ts:72` — `@Optional() private readonly redisService?: RedisService`.
- `apps/billing-service/src/billing/controllers/stripe-webhook.controller.ts:138-150` — `if (this.redisService) { ... }` — silently bypasses dedup if Redis is missing.
- Same `@Optional` pattern repeats on every billing handler that uses Redis for cache invalidation (cancel-subscription:23, change-subscription-plan:53, refund-payment via service, etc.).

**Rule violated**
- Layer-1-nestjs *Rate limiters and quotas must fail closed on Redis outage* (`.claude/knowledge/layer-1-nestjs.md:40`). The webhook idempotency layer is functionally a quota gate.

**Proposed fix direction**
- Make `RedisService` non-optional in `StripeWebhookController.constructor`. Boot fails closed if Redis is unreachable/unconfigured (rather than running with no dedup).
- After BILLING-HIGH-001 lands, persistent dedup makes Redis-miss less catastrophic but still important for rate.

**Affected surface (ripple set)**
- `apps/billing-service/src/billing/controllers/stripe-webhook.controller.ts`
- `apps/billing-service/src/app.module.ts` (verify RedisModule is forRoot, not forRootAsync with degradation paths)

**Expected closer**
billing-expert WRITER mode (small change).

---

#### BILLING-MEDIUM-002 — Stripe webhook is exposed on billing-service directly; should ingress via gateway-api

**Severity:** MEDIUM
**Layer:** 3 (defense-in-depth + observability invariant)
**State:** OPEN

**Evidence**
- `apps/billing-service/src/billing/controllers/stripe-webhook.controller.ts:58` — `@Controller('webhooks')` with route `POST /webhooks/stripe` (becomes `/api/v1/webhooks/stripe` after global prefix).
- `apps/gateway-api/src/proxy/service-proxy.service.ts:783-790` — gateway proxies `/api/billing/*` only. No `webhooks/*` route. Either Stripe is configured to hit billing-service IP directly (bypass) or there is unannounced edge-nginx config not represented in the repo.

**Rule violated**
- Agent invariant *Webhook URL on Stripe dashboard MUST be the gateway-api endpoint, not direct billing-service. Direct exposure = HIGH (bypasses gateway rate-limit + observability)* (`.claude/agents/billing-expert.md:84`). Downgraded to MEDIUM here because nginx-edge could plausibly handle it; this needs explicit confirmation.
- ADR-002 — `gateway-api` is the sole internet-reachable backend; internal services verify inbound HMAC.

**Proposed fix direction**
- Either (a) route `/webhooks/stripe` through gateway-api (gateway preserves raw body, forwards verbatim, billing still verifies HMAC), or (b) explicitly document the nginx-edge route in `infrastructure/` and add a `ServiceIdentityGuard` exception/allowlist for the webhook path.
- Add path to `apps/gateway-api/src/proxy/service-proxy.service.ts` so observability + rate-limit metrics cover the surface.

**Affected surface (ripple set)**
- `apps/gateway-api/src/proxy/service-proxy.service.ts`
- Infrastructure config (nginx / docker-compose port exposure)

**Expected closer**
auth-security-expert ruling on edge topology + arch-arbiter if ADR-002 needs an addendum.

---

#### BILLING-MEDIUM-003 — `failureReason` from Stripe is concatenated into a free-text DB column without truncation or masking

**Severity:** MEDIUM
**Layer:** 1 (PII / log discipline)
**State:** OPEN

**Evidence**
- `apps/billing-service/src/billing/controllers/stripe-webhook.service.ts:201-204` — `failureMessage = paymentIntent.last_payment_error?.message ?? 'Payment failed'`. Not validated, not truncated.
- Persisted to `payment.failureReason` column (`apps/billing-service/src/billing/entities/payment.entity.ts:139-141`) typed `text` — Stripe error messages can include the **last 4 of a card** and sometimes BIN; counts as PII.
- `apps/billing-service/src/billing/handlers/refund-payment.handler.ts:67` — refund reason is taken from request input `input.reason` and stored verbatim.

**Rule violated**
- CLAUDE.md *Mask PII in logs (hash or `***`). The central `maskPii()` helper is auto-applied by `StructuredLoggerService`*.
- Layer-1-core *Cross-cutting disciplines* — input validation requirement.

**Proposed fix direction**
- Add a `failure_reason_code` column (Stripe's `last_payment_error.code` — already extracted as `failureCode`) and use the human message for log only, masked.
- Cap `failureReason` at 500 chars and run `maskPii()` before persist.

**Affected surface (ripple set)**
- `apps/billing-service/src/billing/entities/payment.entity.ts` (new column)
- `apps/billing-service/src/billing/controllers/stripe-webhook.service.ts`
- migration

**Expected closer**
compliance-expert review (GDPR Art. 5 minimisation) + billing-expert WRITER.

---

#### BILLING-MEDIUM-004 — `Subscription.tenantId` carries a `unique` index — only one subscription per tenant lifetime; cancellation+resubscribe path deletes history

**Severity:** MEDIUM
**Layer:** 1 (data model)
**State:** OPEN

**Evidence**
- `apps/billing-service/src/billing/entities/subscription.entity.ts:93` — `@Index(['tenantId'], { unique: true })`.
- `apps/billing-service/src/billing/handlers/create-subscription.handler.ts:81-88` — when an existing CANCELLED subscription is found:
  ```
  await subscriptionRepo.delete({ id: existingSubscription.id });
  ```
  Hard delete to satisfy the unique index. This contradicts the entity's own soft-delete claim (`subscription.entity.ts:204-217`).

**Rule violated**
- Agent invariant *Soft-delete: subscription history must be preserved for billing reconciliation and customer disputes. Physical deletion of a subscription record removes the audit trail* (`apps/billing-service/src/billing/entities/subscription.entity.ts:204-206`). The handler violates the entity's own contract.

**Proposed fix direction**
- Replace the unique index with a partial unique index: `CREATE UNIQUE INDEX ... ON subscriptions (tenant_id) WHERE status NOT IN ('cancelled', 'expired')`.
- Replace the `subscriptionRepo.delete()` with `softDelete()`.
- Migration with the `CONCURRENTLY` keyword on a tenant-active table.

**Affected surface (ripple set)**
- `apps/billing-service/src/billing/entities/subscription.entity.ts`
- `apps/billing-service/src/billing/handlers/create-subscription.handler.ts`
- New migration

**Expected closer**
data-expert + billing-expert pair.

---

#### BILLING-MEDIUM-005 — `TenantUsageMetrics` PK uniqueness OK but `metrics` jsonb column carries no schema check; unbounded growth path

**Severity:** MEDIUM
**Layer:** 1 (jsonb discipline)
**State:** OPEN

**Evidence**
- `apps/billing-service/src/billing/entities/tenant-usage-metrics.entity.ts:152-154` — `@Column('jsonb', { default: {} }) metrics!: ModuleUsageMetrics`. The `MetricUsage` and `ModuleUsageMetrics` types are TS-only; PostgreSQL has no constraint.
- `tenant-usage-metrics.entity.ts:243-264` — `_observationCounts` is a non-persisted in-memory map (`private`) populated only on instances where `updateMetric` is called. Cross-instance state — Welford running mean **resets to zero on every fetch from the DB** because the count isn't stored. The "average" is wrong on the very first save after a cold-fetch.

**Rule violated**
- Layer-1-typeorm *jsonb columns allowed only at documented boundary; domain code may NOT use jsonb as "dumping ground"* (`.claude/knowledge/layer-1-typeorm.md:18`).

**Proposed fix direction**
- Promote `current`, `peak`, `average`, `total`, `observationCount` to first-class columns or to a child table `tenant_usage_metric_values(usage_metric_id, metric_name, current NUMERIC, peak NUMERIC, average NUMERIC, total NUMERIC, observation_count BIGINT)`.
- Welford accumulator MUST be loaded with `count` from DB, not initialised to zero.

**Affected surface (ripple set)**
- `apps/billing-service/src/billing/entities/tenant-usage-metrics.entity.ts`
- migration + child table
- `apps/billing-service/src/modules/metering/usage-aggregator.service.ts`

**Expected closer**
data-expert + billing-expert.

---

#### BILLING-MEDIUM-006 — `MeteredBillingService` cache key is plaintext `subscriptionId-periodStart-periodEnd` and bypasses tenant scoping

**Severity:** MEDIUM
**Layer:** 1 (cache key tenant-scoping discipline)
**State:** OPEN

**Evidence**
- `apps/billing-service/src/modules/metering/metered-billing.service.ts:660-664` — cache key: `${subscriptionId}-${periodStart.getTime()}-${periodEnd.getTime()}`.
- Layer-1-nestjs requires tenant-scoped Redis keys: `cache:<service>:<tenant>:<resource>:<key>`. Even though this is in-process, future refactor to Redis would inherit the bad shape.

**Rule violated**
- Layer-1-nestjs *Cache keys — tenant-scoped: `cache:<service>:<tenant>:<resource>:<key>`* (`.claude/knowledge/layer-1-nestjs.md:71`).

**Proposed fix direction**
- Prefix with `${tenantId}:` — even in-process, this enforces the discipline contract before promotion to Redis.
- Define a shared key-builder util in `libs/backend-common/src/redis/`.

**Affected surface (ripple set)**
- `apps/billing-service/src/modules/metering/metered-billing.service.ts`

**Expected closer**
billing-expert WRITER.

---

### LOW

#### BILLING-LOW-001 — In-memory `breachedThresholds`, `tenantStates`, `meterConfigs` Maps grow unboundedly across tenant lifetime

**Evidence:** `apps/billing-service/src/modules/metering/usage-metering.service.ts:135-140`. No TTL eviction on `tenantStates`. Cleanup only addresses idempotency keys (lines 837-855).

**Fix direction:** LRU cap or scheduled eviction tied to tenant lifecycle (subscription cancellation event). Subsumed by BILLING-CRITICAL-003 redesign.

#### BILLING-LOW-002 — `randomBytes(2)` (16 bits) for invoice-number suffix has ~2.4% collision at 1000 invoices/month per tenant

**Evidence:** `apps/billing-service/src/billing/billing-scheduler.service.ts:432`. Composite key `(tenantId, invoiceNumber)` makes collision recoverable but can crash the cron mid-batch.

**Fix direction:** `randomBytes(4)` (32 bits) — collision risk drops below 1e-7. Or use a per-tenant invoice sequence backed by a DB sequence/advisory lock.

#### BILLING-LOW-003 — Webhook supports only 5 Stripe event types; out-of-band events silently logged

**Evidence:** `apps/billing-service/src/billing/controllers/stripe-webhook.controller.ts:29-37, 169-171`. Common-but-missing events: `invoice.paid`, `invoice.upcoming` (proactive dunning), `customer.subscription.updated`, `payment_method.attached`, `payment_intent.requires_action` (3DS).

**Fix direction:** Pair with the Stripe SDK adoption (BILLING-CRITICAL-001). Add events as the platform's outbound integration grows.

#### BILLING-LOW-004 — `Public()` decorator on the webhook bypasses `ServiceIdentityGuard` HMAC; depends on signature path being the only auth

**Evidence:** `apps/billing-service/src/billing/controllers/stripe-webhook.controller.ts:83`. Comment notes "Stripe-originated requests" but the guard chain in `app.module.ts:204-237` includes `ServiceIdentityGuard` first — `@Public()` correctly skips it. This is intentional; flagged as LOW because the chain is fragile to future guard additions (e.g. adding a global rate-limit guard could accidentally block webhooks).

**Fix direction:** Add an explicit `e2e` test asserting `/webhooks/stripe` reaches the controller without any of the platform guards firing. Promote to invariant once `tests/invariants/webhook-public-paths.spec.ts` is in scope.

## Cross-domain dependencies flagged

- **BILLING-CRITICAL-001** (Stripe SDK adoption) — recommend invoking
  `architectural-arbiter` for ADR-grade decision and `security-reviewer` for
  pair-review (financial regulation surface, per agent definition line 100).
- **BILLING-CRITICAL-002** + **BILLING-HIGH-007** (plan-limit enforcement) —
  recommend invoking `multi-tenant-saas-expert` (delegated owner of plan-tier
  CONTRACT semantics) jointly with billing-expert.
- **BILLING-CRITICAL-003** (atomic metering) — recommend invoking
  `auth-security-expert` for the Lua-script + Redis fail-closed surface.
- **BILLING-HIGH-002** (Money discipline) and **BILLING-HIGH-006** (raw DDL) —
  recommend invoking `data-expert` (migration + entity primary owner).
- **BILLING-HIGH-004** (security-event emission) — recommend invoking
  `auth-security-expert`.
- **BILLING-HIGH-005** (outbox adoption) — recommend invoking `data-expert`
  (outbox primary owner).
- **BILLING-MEDIUM-002** (gateway routing) — recommend invoking
  `auth-security-expert` for edge-topology decision.
- **BILLING-MEDIUM-003** (PII in failureReason) — recommend invoking
  `compliance-expert` (GDPR Art. 5).

## Verdict

**BLOCK.** Three CRITICAL findings prevent the billing-service from operating
correctly in production:

- BILLING-CRITICAL-001 means we cannot bill any customer; only inbound webhook
  state mirroring works.
- BILLING-CRITICAL-002 means even if billing worked, every tenant on every
  paid plan can consume unlimited resources without upcharge.
- BILLING-CRITICAL-003 means the metered-billing engine, even when wired to
  Stripe later, will under-bill at every replica restart and concurrent
  replica deployment.

The seven HIGH findings compound the structural picture and must close in the
same release train. None of these is patchable at handler level — each
requires architectural-arbiter / security-reviewer / data-expert pair-review
and `implementation-planner` skill-DAG composition.

## References

- Layer-1 / Layer-2 / Layer-3 cites inline above.
- ADR-006 (event flat), ADR-007 (CQRS), ADR-011 (schema ownership), ADR-012
  (drift prevention), ADR-002 (gateway sole-edge).
- Agent file: `.claude/agents/billing-expert.md`.
- Inherited from `platform-services.md` Phase 11 split:
  - Stripe webhook persistent-dedup gap (now BILLING-HIGH-001).
  - `MT-HIGH-002` PLAN_LIMITS partial enforcement (now BILLING-CRITICAL-002, escalated).
- Prior cycle baselines this report supersedes: none (first cycle under new
  agent definition; previous reviews lived in `docs/reviews/platform-services/`
  and have not been compaction-cleared).
