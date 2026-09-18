/**
 * ExtendSubscriptionTrialHandler (ADR-0014, BILLING-CRITICAL-003).
 *
 * This replaced a raw `UPDATE billing.subscriptions` in the admin NATS handler
 * that moved `trial_end_date` locally, told Stripe nothing, and overwrote
 * `current_period_end` with the new trial end. Each assertion below is one of
 * the things that statement did not do, or did wrong.
 */
import { StripeApiService } from '@aquaculture/backend-common/billing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { OutboxPublisher } from '@platform/outbox';
import { DataSource } from 'typeorm';

import { ExtendSubscriptionTrialCommand } from '../commands/extend-subscription-trial.command';
import {
  BillingCycle,
  PlanTier,
  Subscription,
  SubscriptionStatus,
} from '../entities/subscription.entity';
import { ExtendSubscriptionTrialHandler } from '../handlers/extend-subscription-trial.handler';

const TENANT = 'tenant-001';
const SUB_ID = 'sub-001';
const ACTOR = 'user-001';
const TRIAL_END = new Date('2026-03-15T00:00:00.000Z');
const PERIOD_END = new Date('2026-03-31T00:00:00.000Z');

function trialSubscription(overrides: Partial<Subscription> = {}): Subscription {
  return Object.assign(new Subscription(), {
    id: SUB_ID,
    tenantId: TENANT,
    planTier: PlanTier.STARTER,
    planName: 'Starter',
    status: SubscriptionStatus.TRIAL,
    billingCycle: BillingCycle.MONTHLY,
    pricing: { basePrice: 49, currency: 'USD' },
    startDate: new Date('2026-03-01'),
    currentPeriodStart: new Date('2026-03-01'),
    currentPeriodEnd: PERIOD_END,
    trialEndDate: TRIAL_END,
    autoRenew: true,
    version: 1,
    ...overrides,
  });
}

interface Harness {
  handler: ExtendSubscriptionTrialHandler;
  stripe: { updateSubscription: jest.Mock };
  outbox: { enqueue: jest.Mock };
}

async function build(row: Subscription | null): Promise<Harness> {
  const stripe = {
    updateSubscription: jest.fn().mockResolvedValue({ id: 'sub_live_123', status: 'trialing' }),
  };
  const outbox = { enqueue: jest.fn().mockResolvedValue(undefined) };
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
      ExtendSubscriptionTrialHandler,
      { provide: DataSource, useValue: dataSource },
      { provide: OutboxPublisher, useValue: outbox },
      { provide: StripeApiService, useValue: stripe },
      { provide: getRepositoryToken(Subscription), useValue: repository },
    ],
  }).compile();

  return { handler: moduleRef.get(ExtendSubscriptionTrialHandler), stripe, outbox };
}

const command = (days: number) => new ExtendSubscriptionTrialCommand(TENANT, SUB_ID, days, ACTOR);

describe('ExtendSubscriptionTrialHandler (ADR-0014)', () => {
  it('moves the trial end by whole days from the current one', async () => {
    const { handler } = await build(trialSubscription());

    const saved = await handler.execute(command(14));

    expect(saved.trialEndDate?.toISOString()).toBe('2026-03-29T00:00:00.000Z');
    expect(saved.updatedBy).toBe(ACTOR);
  });

  it('moves the trial at Stripe too, so the customer is not charged mid-trial', async () => {
    const { handler, stripe } = await build(
      trialSubscription({ stripeSubscriptionId: 'sub_live_123' }),
    );

    await handler.execute(command(14));

    // The raw UPDATE told Stripe nothing: a tenant granted another fortnight
    // was invoiced on the ORIGINAL date, during the trial they were promised.
    expect(stripe.updateSubscription).toHaveBeenCalledWith(
      expect.objectContaining({
        subscriptionId: 'sub_live_123',
        trialEnd: new Date('2026-03-29T00:00:00.000Z'),
      }),
    );
  });

  it('leaves the BILLING period alone', async () => {
    const { handler } = await build(trialSubscription());

    const saved = await handler.execute(command(14));

    // The raw UPDATE set `current_period_end = trial_end`. On a monthly plan
    // that silently moved the next invoice date, and where the period already
    // ran past the trial it moved it BACKWARDS.
    expect(saved.currentPeriodEnd).toEqual(PERIOD_END);
  });

  it('projects the new trial end onto auth.tenants', async () => {
    const { handler, outbox } = await build(trialSubscription());

    await handler.execute(command(14));

    const projection = outbox.enqueue.mock.calls
      .map((call: [{ eventType: string }]) => call[0])
      .find((event: { eventType: string }) => event.eventType === 'TenantSubscriptionChanged');
    expect(projection).toMatchObject({
      subscriptionStatus: SubscriptionStatus.TRIAL,
      trialEndsAt: new Date('2026-03-29T00:00:00.000Z'),
    });
  });

  it('refuses a subscription that is not trialing', async () => {
    const { handler, stripe } = await build(
      trialSubscription({ status: SubscriptionStatus.ACTIVE }),
    );

    await expect(handler.execute(command(14))).rejects.toBeInstanceOf(BadRequestException);
    expect(stripe.updateSubscription).not.toHaveBeenCalled();
  });

  it.each([0, -5, 1.5, 366])('refuses an implausible extension of %s days', async (days) => {
    const { handler } = await build(trialSubscription());
    await expect(handler.execute(command(days))).rejects.toBeInstanceOf(BadRequestException);
  });

  it('raises for a subscription that does not exist', async () => {
    const { handler } = await build(null);
    await expect(handler.execute(command(14))).rejects.toBeInstanceOf(NotFoundException);
  });
});
