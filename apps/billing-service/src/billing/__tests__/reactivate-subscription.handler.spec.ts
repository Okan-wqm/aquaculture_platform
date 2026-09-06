/**
 * ReactivateSubscriptionHandler (ADR-0014, BILLING-CRITICAL-003).
 *
 * This replaced a raw `UPDATE billing.subscriptions` in the admin NATS handler
 * that flipped the status back to active and cleared the cancellation columns —
 * and did nothing else. Each assertion below is one of the things that raw
 * statement did not do, or did wrong.
 */
import { StripeApiService } from '@aquaculture/backend-common/billing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { OutboxPublisher } from '@platform/outbox';
import { DataSource } from 'typeorm';

import { ReactivateSubscriptionCommand } from '../commands/reactivate-subscription.command';
import {
  BillingCycle,
  PlanTier,
  Subscription,
  SubscriptionStatus,
} from '../entities/subscription.entity';
import { ReactivateSubscriptionHandler } from '../handlers/reactivate-subscription.handler';

const TENANT = 'tenant-001';
const SUB_ID = 'sub-001';
const ACTOR = 'user-001';

function cancelledSubscription(overrides: Partial<Subscription> = {}): Subscription {
  return Object.assign(new Subscription(), {
    id: SUB_ID,
    tenantId: TENANT,
    planTier: PlanTier.STARTER,
    planName: 'Starter',
    status: SubscriptionStatus.CANCELLED,
    billingCycle: BillingCycle.MONTHLY,
    pricing: { basePrice: 49, currency: 'USD' },
    startDate: new Date('2026-03-01'),
    currentPeriodStart: new Date('2026-03-01'),
    currentPeriodEnd: new Date('2026-03-31'),
    cancelledAt: new Date('2026-03-10'),
    cancellationReason: 'Customer request',
    endDate: new Date('2026-03-31'),
    autoRenew: false,
    version: 1,
    ...overrides,
  });
}

interface Harness {
  handler: ReactivateSubscriptionHandler;
  stripe: { updateSubscription: jest.Mock };
  outbox: { enqueue: jest.Mock };
  redis: { del: jest.Mock };
}

async function build(row: Subscription | null): Promise<Harness> {
  const stripe = {
    updateSubscription: jest.fn().mockResolvedValue({ id: 'sub_live_123', status: 'active' }),
  };
  const outbox = { enqueue: jest.fn().mockResolvedValue(undefined) };
  const redis = { del: jest.fn().mockResolvedValue(undefined) };
  const manager = {
    findOne: jest.fn().mockResolvedValue(row),
    save: jest.fn((_entity: unknown, value: unknown) => Promise.resolve(value)),
  };
  const dataSource = {
    transaction: (work: (m: unknown) => Promise<unknown>) => work(manager),
  };
  const repository = { findOne: jest.fn().mockResolvedValue(row) };

  const moduleRef = await Test.createTestingModule({
    providers: [
      ReactivateSubscriptionHandler,
      { provide: DataSource, useValue: dataSource },
      { provide: OutboxPublisher, useValue: outbox },
      { provide: StripeApiService, useValue: stripe },
      { provide: getRepositoryToken(Subscription), useValue: repository },
    ],
  }).compile();

  const handler = moduleRef.get(ReactivateSubscriptionHandler);
  // Redis is @Optional; inject it by hand so the cache-invalidation assertion
  // covers the path an operator actually runs.
  Object.assign(handler, { redisService: redis });
  return { handler, stripe, outbox, redis };
}

const command = new ReactivateSubscriptionCommand(TENANT, SUB_ID, ACTOR);

describe('ReactivateSubscriptionHandler (ADR-0014)', () => {
  it('un-schedules the Stripe cancellation, so billing actually resumes', async () => {
    const { handler, stripe } = await build(
      cancelledSubscription({ stripeSubscriptionId: 'sub_live_123' }),
    );

    await handler.execute(command);

    // The raw UPDATE did none of this: Stripe went on stopping the
    // subscription at period end while our row said "active".
    expect(stripe.updateSubscription).toHaveBeenCalledWith(
      expect.objectContaining({
        subscriptionId: 'sub_live_123',
        cancelAtPeriodEnd: false,
      }),
    );
  });

  it('clears the cancellation and restores auto-renew', async () => {
    const row = cancelledSubscription();
    const { handler } = await build(row);

    const saved = await handler.execute(command);

    expect(saved.status).toBe(SubscriptionStatus.ACTIVE);
    expect(saved.cancelledAt).toBeUndefined();
    expect(saved.cancellationReason).toBeUndefined();
    expect(saved.endDate).toBeUndefined();
    expect(saved.autoRenew).toBe(true);
    expect(saved.updatedBy).toBe(ACTOR);
  });

  it('projects the restored state onto auth.tenants', async () => {
    const { handler, outbox } = await build(cancelledSubscription());

    await handler.execute(command);

    // Without this the tenant's entitlements stayed cancelled — the raw
    // UPDATE wrote no event of any kind.
    const projection = outbox.enqueue.mock.calls
      .map((call: [{ eventType: string }]) => call[0])
      .find((event: { eventType: string }) => event.eventType === 'TenantSubscriptionChanged');
    expect(projection).toMatchObject({
      subscriptionStatus: SubscriptionStatus.ACTIVE,
      subscriptionEndsAt: null,
    });
  });

  it('invalidates the cached subscription so callers see the change', async () => {
    const { handler, redis } = await build(cancelledSubscription());
    await handler.execute(command);
    expect(redis.del).toHaveBeenCalledWith(`subscription:${TENANT}`);
  });

  it('refuses a subscription that is not cancelled', async () => {
    const { handler, stripe } = await build(
      cancelledSubscription({ status: SubscriptionStatus.ACTIVE }),
    );

    await expect(handler.execute(command)).rejects.toBeInstanceOf(BadRequestException);
    // And refuses BEFORE touching Stripe.
    expect(stripe.updateSubscription).not.toHaveBeenCalled();
  });

  it('raises for a subscription that does not exist', async () => {
    const { handler } = await build(null);
    await expect(handler.execute(command)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('skips Stripe for a subscription with no Stripe object', async () => {
    const { handler, stripe } = await build(cancelledSubscription());
    await handler.execute(command);
    expect(stripe.updateSubscription).not.toHaveBeenCalled();
  });
});
