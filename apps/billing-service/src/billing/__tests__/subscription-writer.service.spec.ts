/**
 * SubscriptionWriterService — the one place a subscription row is written
 * (ADR-0014, BILLING-CRITICAL-003).
 *
 * Two paths created subscriptions and only one created a Stripe object.
 * `CreateSubscriptionHandler` minted a customer and a subscription; admin
 * tenant provisioning raw-`INSERT`ed with the Stripe columns left NULL, so
 * every operator-provisioned tenant had a subscription this platform believed
 * in and Stripe had never heard of: nothing charged them, and no Stripe
 * webhook could ever resolve to them.
 */
import { StripeApiService } from '@aquaculture/backend-common/billing';
import { Test } from '@nestjs/testing';
import { OutboxPublisher } from '@platform/outbox';
import { DataSource, EntityManager } from 'typeorm';

import { Plan } from '../entities/plan.entity';
import {
  BillingCycle,
  PlanTier,
  Subscription,
  SubscriptionStatus,
} from '../entities/subscription.entity';
import { SubscriptionWriterService, periodEndFor } from '../services/subscription-writer.service';

const TENANT = '22222222-2222-4222-8222-222222222222';
const ACTOR = 'user-001';

const LIMITS = {
  maxFarms: 5,
  maxPonds: 10,
  maxSensors: 20,
  maxUsers: 5,
  dataRetentionDays: 365,
  alertsEnabled: true,
  reportsEnabled: true,
  apiAccessEnabled: false,
  customIntegrationsEnabled: false,
};

const PRICING = {
  basePrice: 149,
  perFarmPrice: 10,
  perSensorPrice: 2,
  perUserPrice: 5,
  currency: 'USD',
};

interface Harness {
  service: SubscriptionWriterService;
  stripe: { createCustomer: jest.Mock; createSubscription: jest.Mock };
  outbox: { enqueue: jest.Mock };
  manager: EntityManager;
  saved: Subscription[];
  /** The row that was written. Fails loudly rather than asserting on `undefined`. */
  written: () => Subscription;
}

async function build(): Promise<Harness> {
  const saved: Subscription[] = [];
  const stripe = {
    createCustomer: jest.fn().mockResolvedValue({ id: 'cus_new' }),
    createSubscription: jest
      .fn()
      .mockResolvedValue({ id: 'sub_new', customer: 'cus_new', status: 'active' }),
  };
  const outbox = { enqueue: jest.fn().mockResolvedValue(undefined) };
  // A REAL EntityManager, from a DataSource that is never initialised: the
  // writer hands it to `OutboxPublisher.enqueue`, which is typed against the
  // real class, so a structural stand-in would have to be cast — and a cast is
  // exactly the thing that hides a signature drifting out from under a test.
  // The two methods the writer calls are stubbed; nothing touches a connection.
  const manager = new DataSource({ type: 'postgres', entities: [] }).manager;
  // `create` and `save` are overloaded (single entity vs. array); the writer
  // only ever uses the single-entity form, so each stub answers that shape.
  // `as never` is how a TypeScript overload set is stubbed — it narrows the
  // implementation signature rather than widening a value into another type.
  jest
    .spyOn(manager, 'create')
    .mockImplementation(((_entity: unknown, value: Subscription) => value) as never);
  jest.spyOn(manager, 'save').mockImplementation((async (_entity: unknown, value: Subscription) => {
    const row = Object.assign({ id: 'sub-uuid-1' }, value);
    saved.push(row);
    return row;
  }) as never);

  const moduleRef = await Test.createTestingModule({
    providers: [
      SubscriptionWriterService,
      { provide: StripeApiService, useValue: stripe },
      { provide: OutboxPublisher, useValue: outbox },
    ],
  }).compile();

  const written = (): Subscription => {
    const row = saved[0];
    if (!row) throw new Error('no subscription row was written');
    return row;
  };
  return {
    service: moduleRef.get(SubscriptionWriterService),
    stripe,
    outbox,
    manager,
    saved,
    written,
  };
}

function planFor(tier: PlanTier, stripePriceIds?: Record<string, string>): Plan {
  return {
    tier,
    name: 'Starter',
    billingCycle: BillingCycle.MONTHLY,
    currency: 'USD',
    stripePriceIds,
  } as Plan;
}

describe('SubscriptionWriterService.ensureStripeObjects', () => {
  it('mints a customer and a subscription when the plan carries a price', async () => {
    const { service, stripe } = await build();

    const refs = await service.ensureStripeObjects({
      tenantId: TENANT,
      plan: planFor(PlanTier.STARTER, { monthly: 'price_123' }),
      billingCycle: BillingCycle.MONTHLY,
    });

    expect(refs).toEqual({ stripeCustomerId: 'cus_new', stripeSubscriptionId: 'sub_new' });
    expect(stripe.createSubscription).toHaveBeenCalledWith(
      expect.objectContaining({ priceId: 'price_123' }),
    );
  });

  it('reuses an existing customer rather than minting a second one', async () => {
    const { service, stripe } = await build();

    await service.ensureStripeObjects({
      tenantId: TENANT,
      plan: planFor(PlanTier.STARTER, { monthly: 'price_123' }),
      billingCycle: BillingCycle.MONTHLY,
      existingCustomerId: 'cus_existing',
    });

    expect(stripe.createCustomer).not.toHaveBeenCalled();
    expect(stripe.createSubscription).toHaveBeenCalledWith(
      expect.objectContaining({ customerId: 'cus_existing' }),
    );
  });

  it('derives idempotency keys from the tenant and plan, so a retry reuses the objects', async () => {
    const { service, stripe } = await build();
    const args = {
      tenantId: TENANT,
      plan: planFor(PlanTier.STARTER, { monthly: 'price_123' }),
      billingCycle: BillingCycle.MONTHLY,
    };

    await service.ensureStripeObjects(args);
    await service.ensureStripeObjects(args);

    const keys = stripe.createSubscription.mock.calls.map(
      (call: [{ idempotencyKey: string }]) => call[0].idempotencyKey,
    );
    expect(keys[0]).toBe(keys[1]);
    expect(keys[0]).toBe(`sub-create:${TENANT}:starter:monthly`);
  });

  it('creates local-only when the plan has no Stripe price for the cycle', async () => {
    const { service, stripe } = await build();

    const refs = await service.ensureStripeObjects({
      tenantId: TENANT,
      plan: planFor(PlanTier.STARTER, { annual: 'price_annual' }),
      billingCycle: BillingCycle.MONTHLY,
    });

    expect(refs.stripeSubscriptionId).toBeUndefined();
    expect(stripe.createSubscription).not.toHaveBeenCalled();
  });
});

describe('SubscriptionWriterService.createWithin', () => {
  const args = {
    tenantId: TENANT,
    plan: planFor(PlanTier.PROFESSIONAL),
    billingCycle: BillingCycle.MONTHLY,
    limits: LIMITS,
    pricing: PRICING,
    startDate: new Date('2026-01-31T00:00:00.000Z'),
    actorId: ACTOR,
    stripe: { stripeCustomerId: 'cus_new', stripeSubscriptionId: 'sub_new' },
  };

  it('writes the Stripe ids onto the row', async () => {
    const { service, manager, written } = await build();

    await service.createWithin(manager, args);

    // The raw provisioning INSERT left both NULL.
    expect(written()).toMatchObject({
      stripeCustomerId: 'cus_new',
      stripeSubscriptionId: 'sub_new',
    });
  });

  it('enqueues SubscriptionCreated on the CALLER transaction', async () => {
    const { service, manager, outbox } = await build();

    await service.createWithin(manager, args);

    const [event, enqueueManager] = outbox.enqueue.mock.calls[0] as [
      { eventType: string },
      EntityManager,
    ];
    expect(event.eventType).toBe('SubscriptionCreated');
    // Atomic with the row: the provisioning path emitted no event at all.
    expect(enqueueManager).toBe(manager);
  });

  it('opens a TRIAL when trial days are granted', async () => {
    const { service, manager, written } = await build();

    await service.createWithin(manager, { ...args, trialDays: 14 });

    expect(written().status).toBe(SubscriptionStatus.TRIAL);
    expect(written().trialEndDate).toEqual(new Date('2026-02-14T00:00:00.000Z'));
  });

  it('keeps FREE at $0 and never on trial, whatever the caller passed', async () => {
    const { service, manager, written } = await build();

    await service.createWithin(manager, {
      ...args,
      plan: planFor(PlanTier.FREE),
      trialDays: 14,
      pricing: { ...PRICING, basePrice: 999 },
    });

    // FREE is a permanent $0 tier, not a time-boxed preview (Faz B), and
    // billing is the SSoT for that (D14) — so it is enforced here, not trusted.
    expect(written().status).toBe(SubscriptionStatus.ACTIVE);
    expect(written().trialEndDate).toBeUndefined();
    expect(written().pricing.basePrice).toBe(0);
    expect(written().pricing.perUserPrice).toBe(0);
  });

  it('defaults autoRenew to true', async () => {
    const { service, manager, written } = await build();
    await service.createWithin(manager, args);
    expect(written().autoRenew).toBe(true);
  });
});

describe('periodEndFor', () => {
  it.each([
    [BillingCycle.MONTHLY, '2026-02-28'],
    [BillingCycle.QUARTERLY, '2026-04-30'],
    [BillingCycle.SEMI_ANNUAL, '2026-07-31'],
    [BillingCycle.ANNUAL, '2027-01-31'],
  ])('clamps %s from Jan 31 to %s', (cycle, expected) => {
    // `Date.setMonth` overflows — Jan 31 + 1 month lands on Mar 3, which on a
    // billing period means an invoice raised two days late every February.
    const end = periodEndFor(new Date(2026, 0, 31), cycle);
    const iso = `${end.getFullYear()}-${String(end.getMonth() + 1).padStart(2, '0')}-${String(
      end.getDate(),
    ).padStart(2, '0')}`;
    expect(iso).toBe(expected);
  });
});
