# Platform Services S2 Audit — HIGH Finding Report

**Date:** 2026-04-05
**Reviewer:** Platform Services Domain Reviewer
**Scope:** billing-service, notification-service, config-service, event-store-service, hydroponics-service
**Prior S1 fixes confirmed applied:** billing.resolver.ts 'system' fallback removed, notification onModuleInit WEBHOOK_ENCRYPTION_KEY validation added, DecimalTransformer applied to billing entities.

---

## Executive Summary

No CRITICAL blocking issues were found in the five services. Seven HIGH-severity findings and four MEDIUM-severity findings are documented below. The most significant architectural gaps are:

1. The `ChangeSubscriptionPlanHandler` executes a downgrade by immediately applying the new lower-tier limits while logging that it "should" take effect at period end — this misrepresents the tenant contract (HIGH).
2. The `scrypt` key-derivation in `EncryptionService` uses a salt derived from the master key itself, making rainbow-table precomputation feasible when the master key is short (HIGH).
3. The `InternalApiKeyGuard` on the event-store service is **not registered globally** — it is only active on routes where it is explicitly applied, meaning `EventStoreController` and `ProjectionsController` are currently unguarded in any environment where `INTERNAL_API_KEY` is unset (HIGH).
4. The `hydroponics-service` `SetupResolver` grants every `MODULE_USER` the ability to `deleteHydroponicsConfiguration` using only the record `id` — there is no ownership validation beyond `tenantId`, which is correct, but the role `MODULE_USER` is the same role that allows read access and thus any module user can destroy another user's named configuration within the same tenant (HIGH — role over-permission).
5. `StripeWebhookService.handlePaymentIntentFailed` creates a new `FAILED` payment record on every call without a DB-level unique guard on `(stripePaymentIntentId, tenantId)` for FAILED status, meaning Stripe retries of the same `payment_intent.payment_failed` event insert duplicate failure records (HIGH — billing integrity).
6. The `safeAdd`/`safeSubtract` helpers throughout billing handlers use `Number * 100` integer promotion, which fails silently for values exceeding 2^53 / 100 and produces incorrect results for values with more than 2 decimal places of precision before multiplication (MEDIUM — not blocking but architecturally wrong for a billing service).
7. The `generateMonthlyInvoices` scheduler does not acquire a pessimistic lock on the `Subscription` record before reading `currentPeriodStart`/`currentPeriodEnd`, meaning two concurrent scheduler instances (e.g., rolling deploy overlap or misconfigured cron) can generate duplicate invoices for the same period before the idempotency `findOne` check completes (MEDIUM — race condition).

---

## HIGH Findings

### H-01 — Downgrade Applies Immediately, Contradicts Stated Contract
**Service:** billing-service
**File:** `apps/billing-service/src/billing/handlers/change-subscription-plan.handler.ts`
**Lines:** 136–164

**Problem:**
The `isDowngrade` branch contains this comment on line 141: `// A production system would use a scheduled_plan_change table.` It then immediately applies the lower-tier `planTier`, `planName`, `limits`, and `pricing` to the live subscription record. The `effectiveDate` mentioned in the log message (line 151) is only logged — it is never stored or enforced. From the moment the command executes, the tenant is operating under the reduced limits even though they have paid for the remainder of the current billing period.

This is a billing accuracy violation. A tenant on the professional tier who downgrades to starter still holds a valid professional subscription until `currentPeriodEnd`. Immediately revoking `limits.maxFarms`, `limits.maxSensors`, etc. at the moment of downgrade request cuts off access the tenant has already paid for.

Additionally, the `SubscriptionUpdatedEvent` published at line 185 carries `previousPlanTier: subscription.planTier`, but by line 185 `subscription.planTier` has already been mutated to the new tier (lines 126, 143, 157), so the event always reports `previousPlanTier == newTier`, making downstream projections unable to detect that a downgrade occurred.

**Root cause:** There is no `scheduled_plan_change` table and no deferred-execution mechanism. The comment acknowledges the gap but leaves it in the "fix later" state.

**Required fix:**
Introduce a `scheduled_plan_changes` table with columns `(id, subscriptionId, tenantId, targetPlanTier, targetPlanName, targetLimits, targetPricing, effectiveAt, appliedAt, status)`. On downgrade, write a row to this table with `effectiveAt = subscription.currentPeriodEnd` and do NOT mutate the active subscription record. A cron job (or the existing `BillingSchedulerService`) applies the pending change when `effectiveAt <= now`. Capture the `previousPlanTier` before mutation for the NATS event.

---

### H-02 — scrypt Salt Derived from Master Key (Weak KDF)
**Service:** config-service
**File:** `apps/config-service/src/configuration/services/encryption.service.ts`
**Lines:** 37–39

**Problem:**
When `CONFIG_ENCRYPTION_KEY` is not a 64-hex-character string, the code falls into the else branch and computes the scrypt salt as:
```
const salt = crypto.createHash('sha256').update(masterKey).digest().subarray(0, 16);
this.derivedKey = crypto.scryptSync(masterKey, salt, 32);
```
The salt is deterministically derived from the masterKey. This defeats the primary purpose of a salt in key derivation, which is to prevent precomputation attacks. An attacker who obtains the scrypt-derived key and knows (or guesses) the derivation scheme can precompute a table of `scryptSync(candidate, sha256(candidate).slice(0,16), 32)` for a dictionary of likely master keys. This is especially dangerous because the `CONFIG_ENCRYPTION_KEY` may be a human-memorable string in staging environments where `NODE_ENV !== 'production'` does not fail startup.

Furthermore, the path `masterKey.length === 64 && /^[0-9a-fA-F]+$/.test(masterKey)` (lines 33–35) uses the raw hex bytes directly as a 256-bit key without any derivation. If the hex string was generated with low entropy (e.g., `xxd -l 32 /dev/urandom | tr -d ' \n'` is correct, but `echo -n "my-secret" | xxd` is not), the key strength is governed purely by input entropy. Neither path validates entropy.

**Root cause:** The salt must be random and stored alongside the ciphertext, not derived from the secret itself.

**Required fix:**
Store a random 32-byte salt in the database (one row per secret, in a `config_encryption_salt` table or as a column on `configurations`). At encryption time: `salt = randomBytes(32)`, `derivedKey = scryptSync(masterKey, salt, 32, { N:16384, r:8, p:1 })`, store `{salt, iv, tag, ciphertext}` in the `ENC_V1:` payload. At decryption time, re-derive the key using the stored salt. This makes every secret's encryption key unique even when the master key is reused.

The simpler path for a 64-hex key should also be documented as requiring genuine 256-bit random generation, with startup entropy validation (`Buffer.from(key,'hex').some(b => b !== 0)` at minimum).

---

### H-03 — Event Store Service Globally Unguarded When INTERNAL_API_KEY Is Unset
**Service:** event-store-service
**File:** `apps/event-store-service/src/guards/internal-api-key.guard.ts`
**Lines:** 33–40
**File:** `apps/event-store-service/src/event-store/event-store.controller.ts` (no `@UseGuards` decorator present)
**File:** `apps/event-store-service/src/projections/projections.controller.ts` (no `@UseGuards` decorator present)

**Problem:**
`InternalApiKeyGuard.canActivate` (line 33–40) checks `process.env['NODE_ENV'] === 'production'` and throws if the key is missing in production. In non-production environments, the guard returns `true` unconditionally when `INTERNAL_API_KEY` is not set. This is an intentional development bypass.

The critical issue is that neither `EventStoreController` nor `ProjectionsController` carries a `@UseGuards(InternalApiKeyGuard)` decorator. The guard is defined and exported but never applied to any route. This means the guard provides zero protection in any environment.

Any service or external caller that can reach the event-store network endpoint can append events (`POST /events/streams/:type/:id`), delete streams (`DELETE /events/streams/:type/:id`), reset projection checkpoints (`POST /projections/:name/reset`), and create arbitrary snapshots (`POST /events/snapshots`) without presenting any API key. The `x-tenant-id` UUID format check is the only validation in place, and that can be any valid UUID.

**Root cause:** The guard was written but not registered. There is no global guard registration in `app.module.ts` or in either controller.

**Required fix:**
Register `InternalApiKeyGuard` as a global guard in `apps/event-store-service/src/app.module.ts`:
```typescript
{ provide: APP_GUARD, useClass: InternalApiKeyGuard }
```
The `/health` path exemption already in the guard covers health probes. Additionally, enforce `INTERNAL_API_KEY` at startup in all environments by moving the check out of the guard and into `onModuleInit` of a bootstrap validator, so that the service refuses to start without the key rather than silently allowing all requests.

---

### H-04 — Duplicate FAILED Payment Records on Stripe Retry
**Service:** billing-service
**File:** `apps/billing-service/src/billing/controllers/stripe-webhook.service.ts`
**Lines:** 217–263 (`handlePaymentIntentFailed`)

**Problem:**
`handlePaymentIntentSucceeded` (line 78–87) checks for an existing `Payment` record by `(stripePaymentIntentId, tenantId)` before creating a new one, providing idempotency. `handlePaymentIntentFailed` (lines 217–263) performs no such check. It calls `manager.create(Payment, {...})` and `manager.save(Payment, payment)` unconditionally on every invocation.

Stripe retries a webhook event up to 72 hours with an exponential backoff when the receiver returns a non-2xx response, or when Stripe's delivery infrastructure experiences a fault. The controller always returns 200, but the outer Redis idempotency key (set at `webhook:stripe:{eventId}`) has a TTL of 72 hours. If Redis is unavailable, the `@Optional() private readonly redisService?` injection means the idempotency check is silently skipped (controller line 138: `if (this.redisService)`). In that scenario, Stripe retries will insert multiple `FAILED` payment rows for the same `stripePaymentIntentId`.

The `Payment` entity has a unique partial index on `stripe_payment_intent_id` only for non-null values:
```
@Index('IDX_payment_stripe_pi', { unique: true, where: '"stripe_payment_intent_id" IS NOT NULL' })
```
This constraint would catch the duplicate at the database level, but it would throw an error from within the transaction, which is caught by `handleStripeWebhook`'s try/catch and silently swallowed (controller line 159–167), returning 200 to Stripe regardless. The net result is the first record is saved, subsequent retries fail silently, and the billing audit log contains a successful Stripe acknowledgement for events that were not processed.

**Root cause:** Missing idempotency check in `handlePaymentIntentFailed` parallel to the one in `handlePaymentIntentSucceeded`.

**Required fix:**
Add the same idempotency guard as `handlePaymentIntentSucceeded`:
```typescript
const existingPayment = await manager.findOne(Payment, {
  where: { stripePaymentIntentId, tenantId },
});
if (existingPayment) {
  this.logger.log(`payment_intent.payment_failed: already recorded for ${stripePaymentIntentId}`);
  return;
}
```
Place this check at the start of the transaction in `handlePaymentIntentFailed`, before `manager.create`. Also harden the Redis fallback path: when `redisService` is absent and `NODE_ENV === 'production'`, log a CRITICAL error. The `@Optional()` Redis injection is appropriate for development but should be validated at startup in production.

---

### H-05 — `MODULE_USER` Role Permits Unrestricted Configuration Deletion Within Tenant
**Service:** hydroponics-service
**File:** `apps/hydroponics-service/src/setup/resolvers/setup.resolver.ts`
**Lines:** 144–154

**Problem:**
`deleteHydroponicsConfiguration` is decorated with `@Roles(Role.MODULE_USER)`. The `MODULE_USER` role is the same role used for read-only queries (`hydroponicsStatus`, `listConfigurations`, `getConfiguration`). Any authenticated user with `MODULE_USER` on the tenant can delete any `HydroponicsConfig` record belonging to their tenant, including records created by administrators, automation scripts, or other users.

In a multi-user tenant (aquaculture operations typically have farm operators, lab technicians, and system integrators sharing one tenant), this allows a low-privilege farm operator to destroy production nutrient configurations that may have taken significant domain expertise to calibrate. There is no ownership field on `HydroponicsConfig` and no role distinction between read, write, and delete operations.

**Root cause:** No role separation between read/write/delete operations and no ownership tracking on the entity.

**Required fix:**
1. Introduce a `createdBy` column on `HydroponicsConfig`.
2. Define distinct roles: `HYDROPONICS_READ` (covers queries), `HYDROPONICS_WRITE` (create/update), `HYDROPONICS_ADMIN` (delete, or delete-own + admin override).
3. Change `deleteHydroponicsConfiguration` to require `HYDROPONICS_ADMIN` or validate that `config.createdBy === currentUserId` for delete-own semantics.

---

### H-06 — Subscription Downgrade Does Not Publish Correct Previous Tier in NATS Event
**Service:** billing-service
**File:** `apps/billing-service/src/billing/handlers/change-subscription-plan.handler.ts`
**Lines:** 124–196

**Problem:**
This is a data integrity issue that cascades to all event-sourced consumers of `SubscriptionUpdated`. The `SubscriptionUpdatedEvent` is constructed at lines 178–196. The `features.previousPlanTier` field (line 196) reads `subscription.planTier`, but by the time this line executes, `subscription.planTier` has already been overwritten by one of lines 126, 143, or 157. In all three branches (upgrade, downgrade, lateral), the subscription object is mutated in place before the event is constructed.

This means `previousPlanTier` always equals `tier` (the new tier) in the published event. Downstream services that use this event to enforce grace periods, adjust feature flags, or calculate prorated credits will operate on incorrect data. The admin-api-service analytics and the notification-service billing event handler both consume this event.

**Root cause:** The previous tier is not captured before mutation.

**Required fix:**
Capture the previous value before any mutation:
```typescript
const previousPlanTier = subscription.planTier;
// ... all mutation branches ...
// In event construction:
features: { ..., previousPlanTier }
```
This is a one-line fix but has broad correctness implications for all downstream consumers.

---

### H-07 — Config `getAll()` Returns Decrypted Secret Values in Bulk Response
**Service:** config-service
**File:** `apps/config-service/src/configuration/services/configuration.service.ts`
**Lines:** 89–133 (`getAll` method)

**Problem:**
`ConfigurationService.getAll()` calls `this.getDecryptedTypedValue(c)` for every configuration record in the result set, including records where `config.isSecret === true`. This means a single call to `getAll(tenantId, 'auth-service')` returns decrypted plaintext values for every secret under that service/tenant combination.

The GraphQL resolver (`configuration.resolver.ts` lines 96–102) masks secret values through the `@ResolveField` `resolveValue`, but `ConfigurationService.getAll()` is also called programmatically by other services that consume it as an internal API. Any internal service that calls `getAll()` and logs, caches in Redis, or includes the result in an error response will leak secrets.

The GraphQL masking is a presentation-layer guard that does not protect programmatic callers of the service layer. Secret values should never be returned in bulk reads; callers that need a specific secret should call `get()` by key and that call should be audited.

**Root cause:** No differentiation between secret and non-secret values in the bulk-read path at the service layer.

**Required fix:**
In `getAll()`, replace `this.getDecryptedTypedValue(c)` with a wrapper that for secret configs returns the string `'[ENCRYPTED]'` or omits the key entirely from the result map. Only the single-key `get()` call should decrypt, and only when the caller explicitly requests a secret key by name. Add an audit log entry to `get()` when the resolved config has `isSecret === true`.

---

## MEDIUM Findings

### M-01 — `safeAdd`/`safeSubtract` Are Not True Decimal Arithmetic
**Service:** billing-service
**Files:** `stripe-webhook.service.ts` lines 19–25, `record-payment.handler.ts` lines 15–21, `refund-payment.handler.ts` lines 14–19
**Severity:** MEDIUM

The helpers `safeAdd` and `safeSubtract` round inputs to the nearest cent (`Math.round(a * 100)`), then do integer arithmetic, then divide by 100. This is not the same as decimal arithmetic. For values like `0.075` (a tax calculation), `Math.round(0.075 * 100) = 8` rather than the correct 7.5 cents, introducing a systematic rounding error. More critically, for large invoices where `a` or `b` exceeds `Number.MAX_SAFE_INTEGER / 100 ≈ 90_071_992_547.40$`, the multiplication overflows JavaScript's 53-bit integer mantissa and produces wrong results.

A billing service handling enterprise aquaculture deployments with annual billing cycles may generate invoices large enough to approach these limits. The correct solution is to use an arbitrary-precision decimal library (`decimal.js` or `big.js`) for all monetary calculations, or to store and operate on values as integer cents throughout and convert only at the presentation layer.

---

### M-02 — Auto-Invoice Scheduler Has No Distributed Lock (Duplicate Risk on Multi-Instance Deploy)
**Service:** billing-service
**File:** `apps/billing-service/src/billing/billing-scheduler.service.ts`
**Lines:** 198–347 (`generateMonthlyInvoices`)
**Severity:** MEDIUM

`generateMonthlyInvoices` runs at `0 1 1 * *`. If two billing-service instances are alive simultaneously (rolling deploy, blue-green), both will execute this cron at the same time. The idempotency check at lines 222–237 (`findOne` on subscriptionId + periodStart + periodEnd) is a read, not a lock. Between the `findOne` returning `null` and `invoiceRepo.save(invoice)`, the other instance may also read `null` and save a duplicate invoice. The existing idempotency guard would catch this on the second invocation only if the first has already committed — there is a race window during the transaction.

The scheduler also calls `advanceSubscriptionPeriod` (line 330) without holding a pessimistic lock on the subscription, meaning the period advance itself can double-apply if both instances process the same subscription.

Fix: Use a database advisory lock (`SELECT pg_try_advisory_xact_lock(hashtext('generate-monthly-invoices'))`) at the start of the cron job to ensure only one instance runs the job at a time.

---

### M-03 — Webhook Encryption Key Module-Level Global Variable Is Not Reset Between Tests
**Service:** notification-service
**File:** `apps/notification-service/src/notification/services/notification-dispatcher.service.ts`
**Lines:** 97–122
**Severity:** MEDIUM

`WEBHOOK_ENCRYPTION_KEY` is declared as a module-level `let` variable (line 97), not as an instance variable on `NotificationDispatcherService`. When `onModuleInit` is called in a test that provides no key, the fallback path (line 230) sets the global to a predictable derived value. If a later test (or production instance created without `REQUIRE_WEBHOOK_ENCRYPTION_KEY=true`) relies on encryption being unavailable, it will silently use the insecure dev key. The fix is to move `WEBHOOK_ENCRYPTION_KEY` to a private readonly instance property on `NotificationDispatcherService`, initialized in `onModuleInit` and injected into the encrypt/decrypt functions as a parameter. This also makes the service testable in isolation.

---

### M-04 — `handleSubscriptionExpiry` Transitions to EXPIRED Without Publishing a NATS Event
**Service:** billing-service
**File:** `apps/billing-service/src/billing/billing-scheduler.service.ts`
**Lines:** 108–144 (`handleSubscriptionExpiry`)
**Severity:** MEDIUM

When a subscription transitions to `EXPIRED` via `handleSubscriptionExpiry`, no NATS event is published. Other services that need to react to expiry (admin-service to revoke module access, notification-service to send expiry warning, auth-service to downgrade user roles) have no notification mechanism. The `handleTrialExpiry` scheduler also transitions to `PAST_DUE` without a NATS event. Both state transitions should publish a `SubscriptionExpired` or `SubscriptionStatusChanged` event so the platform can respond consistently.

---

## Findings Summary Table

| ID   | Severity | Service                | File (short path)                           | Issue                                          |
|------|----------|------------------------|---------------------------------------------|------------------------------------------------|
| H-01 | HIGH     | billing-service        | handlers/change-subscription-plan.handler.ts | Downgrade applies immediately, contract broken |
| H-02 | HIGH     | config-service         | services/encryption.service.ts              | scrypt salt derived from master key            |
| H-03 | HIGH     | event-store-service    | guards/internal-api-key.guard.ts            | Guard defined but never applied to controllers |
| H-04 | HIGH     | billing-service        | controllers/stripe-webhook.service.ts       | Duplicate FAILED payment on Stripe retry       |
| H-05 | HIGH     | hydroponics-service    | resolvers/setup.resolver.ts                 | MODULE_USER can delete any config in tenant    |
| H-06 | HIGH     | billing-service        | handlers/change-subscription-plan.handler.ts | previousPlanTier always equals new tier in event |
| H-07 | HIGH     | config-service         | services/configuration.service.ts           | getAll() decrypts and returns secret values    |
| M-01 | MEDIUM   | billing-service        | multiple handlers                            | safeAdd/safeSubtract not true decimal arithmetic |
| M-02 | MEDIUM   | billing-service        | billing-scheduler.service.ts                | No distributed lock on monthly invoice cron   |
| M-03 | MEDIUM   | notification-service   | services/notification-dispatcher.service.ts | WEBHOOK_ENCRYPTION_KEY is a mutable global     |
| M-04 | MEDIUM   | billing-service        | billing-scheduler.service.ts                | EXPIRED/PAST_DUE transitions publish no event  |

---

## Items Confirmed Clean (Not Flagged)

- **Stripe HMAC verification (main webhook path):** Correct. `verifySignature` uses `createHmac`, timing-safe compare, and 5-minute timestamp window. Applied unconditionally before any processing. No skip path in the retry or happy-path branch.
- **Config service secret masking in GraphQL:** `@ResolveField value` returns `[ENCRYPTED]` for `isSecret` records. Correct at the presentation layer.
- **Config secret redaction in history:** Both `UpdateConfigurationHandler` (line 82–94) and `UpsertConfigurationHandler` (line 85–87) write `[REDACTED]` for secret values in `ConfigurationHistory`. Correct.
- **Event store tenant isolation:** All reads and writes in `EventStoreService` include `tenantId` in the WHERE clause. `StoredEvent`, `EventStream`, and `Snapshot` entities all carry `tenantId` as a `uuid` column. The controller validates `x-tenant-id` as a UUID v4 before passing it to the service. Correct.
- **Notification SSRF prevention:** `BLOCKED_HOSTS` and `BLOCKED_IP_PATTERNS` cover AWS metadata (169.254.169.254), GCP metadata, all RFC1918 ranges, CGNAT, and IPv6 ULA/link-local. Correct.
- **Notification webhook retry path (HMAC / signature):** The retry path in `retryFailedNotifications` calls `sendWebhook` which calls `isValidWebhookUrl` for SSRF validation. The encrypted URL is decrypted from `metadata.encryptedWebhookUrl`. No bypass of validation on retry.
- **Hydroponics tenant isolation:** All repository operations in `SetupResolver` include `tenantId` in the WHERE clause. The `@CurrentTenant()` decorator sourced from JWT. No IDOR on reads or mutations (finding H-05 is about role scope, not tenant isolation).
- **Event store immutability:** No `UPDATE` or `DELETE` on `StoredEvent` anywhere in the codebase. `deleteStream` performs a soft delete on `EventStream` only. Snapshots can be upserted (correct — they are read-optimization artifacts, not events). Confirmed immutable.
- **Billing idempotency key (Redis):** `StripeWebhookController` sets `webhook:stripe:{eventId}` via `setNx` with 72h TTL before routing. This covers the main path correctly. The Redis-absent path logs and proceeds (noted as a known gap in H-04).
