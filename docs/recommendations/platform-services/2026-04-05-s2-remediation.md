# Platform Services S2 — Remediation Recommendations

**Date:** 2026-04-05
**Based on:** `docs/reviews/platform-services/2026-04-05-s2-high-findings.md`
**Deploy blocker:** None of the HIGH findings block the current deploy in isolation, but H-01 and H-06 together constitute a billing contract violation that should be resolved before the next customer-facing release. H-03 blocks production hardening of the event-store service.

---

## H-01: Deferred Downgrade via Scheduled Plan Changes Table

**Finding:** Subscription downgrades apply immediately despite documentation and comments stating they should take effect at period end.

**Architectural solution:**

Introduce a `scheduled_plan_changes` table and a corresponding `ScheduledPlanChange` entity. The `ChangeSubscriptionPlanHandler` creates a pending row instead of mutating the subscription. The `BillingSchedulerService` applies pending changes at period end.

Schema (TypeORM entity skeleton):
```typescript
@Entity('scheduled_plan_changes')
@Index(['subscriptionId', 'status'])
@Index(['effectiveAt', 'status'])
export class ScheduledPlanChange {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ type: 'uuid' }) subscriptionId: string;
  @Column({ type: 'uuid' }) tenantId: string;
  @Column({ type: 'enum', enum: PlanTier }) previousTier: PlanTier;
  @Column({ type: 'enum', enum: PlanTier }) targetTier: PlanTier;
  @Column() previousPlanName: string;
  @Column() targetPlanName: string;
  @Column({ type: 'jsonb' }) targetLimits: PlanLimits;
  @Column({ type: 'jsonb' }) targetPricing: PlanPricing;
  @Column({ type: 'timestamptz' }) effectiveAt: Date;
  @Column({ type: 'timestamptz', nullable: true }) appliedAt?: Date;
  @Column({ type: 'varchar', default: 'pending' }) status: 'pending' | 'applied' | 'cancelled';
  @Column({ nullable: true }) cancelledBy?: string;
  @Column() createdBy: string;
  @CreateDateColumn() createdAt: Date;
}
```

In `ChangeSubscriptionPlanHandler.execute`, the downgrade branch:
1. Captures `previousPlanTier = subscription.planTier` before any write.
2. Does NOT mutate the subscription object.
3. Writes a `ScheduledPlanChange` row with `effectiveAt = subscription.currentPeriodEnd`.
4. Publishes a `SubscriptionDowngradeScheduled` NATS event with correct `previousPlanTier`.

In `BillingSchedulerService`, add an hourly cron:
```typescript
@Cron(CronExpression.EVERY_HOUR)
async applyScheduledPlanChanges(): Promise<void> {
  const pg_lock = await this.dataSource.query(
    `SELECT pg_try_advisory_xact_lock(hashtext('apply-plan-changes'))`
  );
  // ... apply pending rows where effectiveAt <= now
}
```

**Files to modify:**
- `apps/billing-service/src/billing/handlers/change-subscription-plan.handler.ts`
- `apps/billing-service/src/billing/billing-scheduler.service.ts`
- `apps/billing-service/src/billing/billing.module.ts` (add entity)
- New: `apps/billing-service/src/billing/entities/scheduled-plan-change.entity.ts`
- New migration required

---

## H-02: Fix scrypt Key Derivation (Per-Secret Random Salt)

**Finding:** The scrypt salt in `EncryptionService` is deterministically derived from the master key, enabling precomputation attacks.

**Architectural solution:**

Store a per-secret random salt in the encrypted payload. Revise the `ENC_V1:` format to `ENC_V2:` to include the salt:

```typescript
// New payload format (base64 of JSON):
// { v: 2, salt: hex, iv: hex, tag: hex, data: hex }

encrypt(plaintext: string): string {
  if (!this.masterKey) throw new Error('Encryption unavailable');
  const salt = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(this.masterKey, salt, 32, { N: 16384, r: 8, p: 1 });
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const payload = JSON.stringify({
    v: 2,
    salt: salt.toString('hex'),
    iv: iv.toString('hex'),
    tag: cipher.getAuthTag().toString('hex'),
    data: encrypted,
  });
  return 'ENC_V2:' + Buffer.from(payload).toString('base64');
}

decrypt(value: string): string {
  // Support both ENC_V1 (legacy, no salt — use empty salt for backward compat) and ENC_V2
  const isV2 = value.startsWith('ENC_V2:');
  const isV1 = value.startsWith('ENC_V1:');
  const payload = JSON.parse(Buffer.from(
    value.slice(isV2 ? 7 : 7), 'base64'
  ).toString('utf8'));
  const salt = isV2
    ? Buffer.from(payload.salt, 'hex')
    : crypto.createHash('sha256').update(this.masterKey).digest().subarray(0, 16);
  const key = isV2
    ? crypto.scryptSync(this.masterKey, salt, 32, { N: 16384, r: 8, p: 1 })
    : this.derivedKey; // legacy path uses pre-derived key
  // ... standard AES-256-GCM decryption
}
```

Store `masterKey` as a private string field, not as a pre-derived `Buffer`, so each decrypt call can re-derive with the payload's unique salt. The 64-hex direct-key path should be removed; it gives a false sense of security without entropy validation.

Plan a migration that re-encrypts all `ENC_V1:` values to `ENC_V2:` format during the next deploy window.

**Files to modify:**
- `apps/config-service/src/configuration/services/encryption.service.ts`

---

## H-03: Register InternalApiKeyGuard Globally on Event Store Service

**Finding:** `InternalApiKeyGuard` is defined but never applied to any route.

**Architectural solution:**

Register the guard as an application-level global guard. In `apps/event-store-service/src/app.module.ts`:

```typescript
import { APP_GUARD } from '@nestjs/core';
import { InternalApiKeyGuard } from './guards/internal-api-key.guard';

@Module({
  providers: [
    { provide: APP_GUARD, useClass: InternalApiKeyGuard },
  ],
})
export class AppModule {}
```

Additionally, add startup enforcement so the service fails fast when `INTERNAL_API_KEY` is missing in production:

```typescript
// In InternalApiKeyGuard constructor or a bootstrap validator:
constructor() {
  if (process.env['NODE_ENV'] === 'production' && !process.env['INTERNAL_API_KEY']) {
    throw new Error('INTERNAL_API_KEY is required in production. Service cannot start.');
  }
}
```

The `/health` path exemption (`request.path.includes('/health')`) already in the guard is sufficient to keep health probes working without a key.

**Files to modify:**
- `apps/event-store-service/src/app.module.ts`
- `apps/event-store-service/src/guards/internal-api-key.guard.ts` (add constructor validation)

---

## H-04: Idempotency Guard for payment_intent.payment_failed

**Finding:** `handlePaymentIntentFailed` creates duplicate FAILED payment records on Stripe retry.

**Architectural solution:**

Mirror the idempotency check from `handlePaymentIntentSucceeded`. In `StripeWebhookService.handlePaymentIntentFailed`, inside the transaction (after the manager is opened, before `manager.create`):

```typescript
const existingPayment = await manager.findOne(Payment, {
  where: { stripePaymentIntentId, tenantId },
});
if (existingPayment) {
  this.logger.log(
    `payment_intent.payment_failed: already recorded for ${stripePaymentIntentId} ` +
    `(status: ${existingPayment.status}), skipping`,
  );
  return;
}
```

Also harden the Redis-absent production path. In `StripeWebhookController`, add a startup check:

```typescript
onModuleInit(): void {
  if (!this.redisService && process.env['NODE_ENV'] === 'production') {
    throw new Error(
      'RedisService is required for webhook idempotency in production. ' +
      'Ensure Redis is provisioned and @Optional() is removed from the constructor injection.',
    );
  }
}
```

**Files to modify:**
- `apps/billing-service/src/billing/controllers/stripe-webhook.service.ts`
- `apps/billing-service/src/billing/controllers/stripe-webhook.controller.ts` (add `OnModuleInit`)

---

## H-05: Role Separation for Hydroponics Configuration Deletion

**Finding:** `MODULE_USER` role permits deletion of any configuration in the tenant.

**Architectural solution:**

1. Add `createdBy` and `updatedBy` columns to `HydroponicsConfig`:
```typescript
@Column({ nullable: true, name: 'created_by' })
createdBy?: string;

@Column({ nullable: true, name: 'updated_by' })
updatedBy?: string;
```

2. Define granular roles in the shared `Role` enum (or hydroponics-specific sub-roles):
- `HYDROPONICS_READ` — list and get
- `HYDROPONICS_WRITE` — create and update  
- `HYDROPONICS_ADMIN` — delete any record, or promote to admin

3. Change `deleteHydroponicsConfiguration`:
```typescript
@Mutation(() => Boolean)
@Roles(Role.HYDROPONICS_ADMIN)  // or: HYDROPONICS_WRITE + ownership check
async deleteHydroponicsConfiguration(
  @Args('id') id: string,
  @CurrentTenant() tenantId: string,
  @CurrentUser() userId: string,
): Promise<boolean> {
  const config = await this.configRepository.findOne({ where: { id, tenantId } });
  if (!config) throw new NotFoundException();
  // If not HYDROPONICS_ADMIN, verify ownership:
  // if (config.createdBy !== userId) throw new ForbiddenException();
  const result = await this.configRepository.delete({ id, tenantId });
  return (result.affected ?? 0) > 0;
}
```

**Files to modify:**
- `apps/hydroponics-service/src/setup/entities/hydroponics-config.entity.ts`
- `apps/hydroponics-service/src/setup/resolvers/setup.resolver.ts`
- New migration required

---

## H-06: Capture previousPlanTier Before Mutation

**Finding:** `SubscriptionUpdatedEvent.features.previousPlanTier` always equals the new tier because the subscription object is mutated before the event is constructed.

**Fix** (one-line, high correctness impact):

In `ChangeSubscriptionPlanHandler.execute`, at line 110 (before any branch):

```typescript
// Capture BEFORE any mutation:
const previousPlanTier = subscription.planTier;
const previousPlanName = subscription.planName;
```

In the event construction (line 196), replace `subscription.planTier` with `previousPlanTier`:
```typescript
features: {
  ...,
  previousPlanTier,
  previousPlanName,
}
```

**Files to modify:**
- `apps/billing-service/src/billing/handlers/change-subscription-plan.handler.ts`

---

## H-07: Exclude Secret Values from getAll() Bulk Response

**Finding:** `ConfigurationService.getAll()` decrypts and returns plaintext secret values.

**Architectural solution:**

In `getAll()`, replace the `getDecryptedTypedValue` call with a presentation-safe variant:

```typescript
// In getAll():
configs
  .filter((c) => c.tenantId === 'global')
  .forEach((c) => {
    result[c.key] = c.isSecret ? '[ENCRYPTED]' : this.getDecryptedTypedValue(c);
  });
configs
  .filter((c) => c.tenantId !== 'global')
  .forEach((c) => {
    result[c.key] = c.isSecret ? '[ENCRYPTED]' : this.getDecryptedTypedValue(c);
  });
```

Separately, add an audit log to `get()` when the resolved config is a secret:
```typescript
if (config.isSecret) {
  this.logger.log(
    `Secret config access: ${service}/${key} by tenant ${tenantId}`,
  );
}
```

This preserves the existing `get(tenantId, service, key)` path as the only legitimate way to obtain a decrypted secret value.

**Files to modify:**
- `apps/config-service/src/configuration/services/configuration.service.ts`

---

## M-01: Replace safeAdd/safeSubtract with Decimal.js

**Finding:** Integer-promotion helpers are not true decimal arithmetic and overflow for large amounts.

**Architectural solution:**

Add `decimal.js` to billing-service dependencies. Replace all monetary arithmetic:

```typescript
import Decimal from 'decimal.js';

// Configure globally: no exponential notation, 10 decimal places max
Decimal.set({ toExpPos: 20, toExpNeg: -7, precision: 28 });

function addMoney(a: number | string, b: number | string): number {
  return new Decimal(a).plus(new Decimal(b)).toDecimalPlaces(2).toNumber();
}

function subtractMoney(a: number | string, b: number | string): number {
  return new Decimal(a).minus(new Decimal(b)).toDecimalPlaces(2).toNumber();
}
```

Pass `Number(invoice.amountPaid).toString()` to avoid floating-point contamination before Decimal construction.

**Files to modify:** All billing handler files that currently import `safeAdd`/`safeSubtract`, and `stripe-webhook.service.ts`.

---

## M-02: Distributed Lock for Monthly Invoice Cron

**Finding:** No distributed lock prevents duplicate invoice generation on multi-instance deploy.

**Architectural solution:**

Use PostgreSQL advisory locks. At the top of `generateMonthlyInvoices`:

```typescript
async generateMonthlyInvoices(): Promise<void> {
  const lockId = 1234567890; // fixed integer, unique per job
  const [{ acquired }] = await this.dataSource.query(
    `SELECT pg_try_advisory_lock($1) AS acquired`, [lockId]
  );
  if (!acquired) {
    this.logger.log('Monthly invoice generation: lock not acquired, another instance is running');
    return;
  }
  try {
    // ... existing logic
  } finally {
    await this.dataSource.query(`SELECT pg_advisory_unlock($1)`, [lockId]);
  }
}
```

Alternatively, use the `@nestjs/bull` job queue with a single worker configuration for the invoice generation job, which provides distributed coordination through Redis.

**Files to modify:**
- `apps/billing-service/src/billing/billing-scheduler.service.ts`

---

## M-03: Move Webhook Encryption Key to Instance Variable

**Finding:** Module-level `WEBHOOK_ENCRYPTION_KEY` is a mutable global shared across test runs and service instances.

**Architectural solution:**

Convert to a private instance property:

```typescript
@Injectable()
export class NotificationDispatcherService implements OnModuleInit {
  private webhookEncryptionKey!: Buffer;

  onModuleInit(): void {
    const envKey = this.configService.get<string>('WEBHOOK_ENCRYPTION_KEY');
    if (envKey && envKey.length >= 32) {
      this.webhookEncryptionKey = createHash('sha256').update(envKey).digest();
      return;
    }
    // ... strict mode / fallback logic
  }

  private encryptWebhookUrl(url: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.webhookEncryptionKey, iv);
    // ...
  }
}
```

Remove the module-level `let WEBHOOK_ENCRYPTION_KEY` declaration entirely.

**Files to modify:**
- `apps/notification-service/src/notification/services/notification-dispatcher.service.ts`

---

## M-04: Publish NATS Events for EXPIRED and PAST_DUE Scheduler Transitions

**Finding:** `handleSubscriptionExpiry` and `handleTrialExpiry` (PAST_DUE branch) do not publish NATS events.

**Architectural solution:**

Add a `SubscriptionExpired` event to `@platform/event-contracts` and publish it from `handleSubscriptionExpiry`:

```typescript
const natsEvent: SubscriptionExpiredEvent = {
  ...createBaseEvent('SubscriptionExpired', sub.tenantId),
  subscriptionId: sub.id,
  expiredAt: now,
  planTier: sub.planTier,
};
await this.eventBus?.publish(natsEvent);
```

Similarly, publish `SubscriptionPastDue` (or reuse `SubscriptionStatusChanged`) from the PAST_DUE branch in `handleTrialExpiry`. This enables admin-service to revoke module access and notification-service to send expiry emails.

**Files to modify:**
- `apps/billing-service/src/billing/billing-scheduler.service.ts`
- `libs/platform/event-contracts/` (new event types)

---

## Remediation Priority

| Priority | Finding | Complexity | Risk if deferred             |
|----------|---------|------------|------------------------------|
| 1        | H-06    | Low (1 line)| Incorrect downstream events  |
| 2        | H-04    | Low        | Duplicate billing records    |
| 3        | H-07    | Low        | Secret exposure to callers   |
| 4        | H-03    | Low        | Unprotected event store API  |
| 5        | H-01    | High       | Contract/billing violation   |
| 6        | H-02    | Medium     | Weak secret encryption       |
| 7        | H-05    | Medium     | Privilege abuse within tenant|
| 8        | M-01    | High       | Billing arithmetic errors    |
| 9        | M-02    | Low        | Duplicate invoices on deploy |
| 10       | M-03    | Low        | Test isolation / key leakage |
| 11       | M-04    | Medium     | Missing platform events      |
