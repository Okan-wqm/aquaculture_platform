/**
 * CancelSubscriptionHandler Unit Tests
 *
 * Tests the CQRS command handler for cancelling subscriptions including:
 * - Cancellable status gating
 * - Cancellation reason length validation
 * - Transactional outbox publishing (events commit atomically with the cancel)
 */

import { NotFoundException, BadRequestException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { StripeApiService } from '@aquaculture/backend-common/billing';
import { OutboxPublisher } from '@platform/outbox';
import { DataSource } from 'typeorm';
import { CancelSubscriptionHandler } from '../handlers/cancel-subscription.handler';
import { CancelSubscriptionCommand } from '../commands/cancel-subscription.command';
import { Subscription, SubscriptionStatus, PlanTier, BillingCycle } from '../entities/subscription.entity';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildSubscription(overrides: Partial<Subscription> = {}): Partial<Subscription> {
  return {
    id: 'sub-001',
    tenantId: 'tenant-001',
    planTier: PlanTier.STARTER,
    planName: 'Starter',
    status: SubscriptionStatus.ACTIVE,
    billingCycle: BillingCycle.MONTHLY,
    pricing: { basePrice: 49, currency: 'USD' },
    startDate: new Date('2026-03-01'),
    currentPeriodStart: new Date('2026-03-01'),
    currentPeriodEnd: new Date('2026-03-31'),
    autoRenew: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    version: 1,
    ...overrides,
  };
}

function buildCommand(
  reason = 'Customer request',
  subscriptionId = 'sub-001',
  tenantId = 'tenant-001',
  userId = 'user-001',
  cancelImmediately = false,
): CancelSubscriptionCommand {
  return new CancelSubscriptionCommand(
    tenantId,
    subscriptionId,
    reason,
    userId,
    cancelImmediately,
  );
}

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function createMockManager(subscription: Partial<Subscription> | null) {
  const manager = {
    findOne: jest.fn().mockImplementation((entity: unknown) => {
      if (entity === Subscription) return Promise.resolve(subscription);
      return Promise.resolve(null);
    }),
    save: jest.fn().mockImplementation((_entity: unknown, data: unknown) => Promise.resolve(data)),
  };
  return manager;
}

function createMockDataSource(
  manager: ReturnType<typeof createMockManager>,
): jest.Mocked<Partial<DataSource>> {
  return {
    transaction: jest.fn().mockImplementation(
      (cb: (mgr: typeof manager) => Promise<unknown>) => cb(manager),
    ),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CancelSubscriptionHandler', () => {
  let handler: CancelSubscriptionHandler;
  let mockManager: ReturnType<typeof createMockManager>;
  let mockDS: ReturnType<typeof createMockDataSource>;
  let mockOutbox: { enqueue: jest.Mock };
  let mockStripe: { cancelSubscription: jest.Mock };
  let mockSubscriptionRepo: { findOne: jest.Mock };
  let defaultSubscription: Partial<Subscription>;

  beforeEach(async () => {
    defaultSubscription = buildSubscription();
    mockManager = createMockManager(defaultSubscription);
    mockDS = createMockDataSource(mockManager);
    mockOutbox = { enqueue: jest.fn().mockResolvedValue(undefined) };
    mockStripe = {
      cancelSubscription: jest.fn().mockResolvedValue({ id: 'sub_test', status: 'canceled' }),
    };
    // Pre-tx read for the Stripe id. Default sub has no stripeSubscriptionId →
    // no Stripe call (local-only path).
    mockSubscriptionRepo = { findOne: jest.fn().mockResolvedValue(defaultSubscription) };

    const moduleRef = await Test.createTestingModule({
      providers: [
        CancelSubscriptionHandler,
        { provide: DataSource, useValue: mockDS },
        { provide: OutboxPublisher, useValue: mockOutbox },
        { provide: StripeApiService, useValue: mockStripe },
        { provide: getRepositoryToken(Subscription), useValue: mockSubscriptionRepo },
      ],
    }).compile();

    handler = moduleRef.get(CancelSubscriptionHandler);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Stripe cancellation (SSOT-C-12)', () => {
    it('cancels the Stripe subscription (at period end) when one is linked', async () => {
      mockSubscriptionRepo.findOne.mockResolvedValue(
        buildSubscription({ stripeSubscriptionId: 'sub_live_123' }),
      );

      await handler.execute(buildCommand());

      expect(mockStripe.cancelSubscription).toHaveBeenCalledTimes(1);
      const args = mockStripe.cancelSubscription.mock.calls[0][0];
      expect(args.subscriptionId).toBe('sub_live_123');
      expect(args.immediately).toBe(false);
      // ADR-0014: the key carries the immediacy, so a scheduled cancel and an
      // immediate one are not the same Stripe request.
      expect(args.idempotencyKey).toBe('sub-cancel:sub_live_123:period-end');
    });

    it('skips Stripe when the subscription has no Stripe id (local-only)', async () => {
      // default sub has no stripeSubscriptionId
      await handler.execute(buildCommand());
      expect(mockStripe.cancelSubscription).not.toHaveBeenCalled();
    });

    it('does NOT mutate local state when the Stripe cancel fails (fail-closed)', async () => {
      mockSubscriptionRepo.findOne.mockResolvedValue(
        buildSubscription({ stripeSubscriptionId: 'sub_live_123' }),
      );
      mockStripe.cancelSubscription.mockRejectedValue(new Error('stripe down'));

      await expect(handler.execute(buildCommand())).rejects.toThrow('stripe down');
      // Stripe failed before the DB tx opened → no local save / no event.
      expect(mockManager.save).not.toHaveBeenCalled();
      expect(mockOutbox.enqueue).not.toHaveBeenCalled();
    });
  });

  describe('Successful cancellation', () => {
    it('should cancel an active subscription and set status CANCELLED', async () => {
      const result = await handler.execute(buildCommand());

      expect(result.status).toBe(SubscriptionStatus.CANCELLED);
      expect(result.autoRenew).toBe(false);
      expect(result.cancelledAt).toBeDefined();
    });
  });

  describe('Cancellation validation', () => {
    it('should reject cancellation when subscription is not found', async () => {
      mockManager.findOne.mockResolvedValue(null);

      await expect(handler.execute(buildCommand())).rejects.toThrow(NotFoundException);
    });

    it('should reject cancellation for a non-cancellable status', async () => {
      defaultSubscription.status = SubscriptionStatus.CANCELLED;

      await expect(handler.execute(buildCommand())).rejects.toThrow(BadRequestException);
    });

    it('should reject an over-length cancellation reason', async () => {
      await expect(handler.execute(buildCommand('x'.repeat(1001))).catch((e) => {
        throw e;
      })).rejects.toThrow(BadRequestException);
    });
  });

  describe('Transactional outbox publishing', () => {
    it('should enqueue SubscriptionCancelled and TenantSubscriptionChanged on the transactional manager', async () => {
      await handler.execute(buildCommand());

      // Both the cancellation event and the auth.tenants projection must be
      // enqueued into the outbox on the SAME transactional manager so they
      // commit atomically with the cancellation — no fire-and-forget publish.
      expect(mockOutbox.enqueue).toHaveBeenCalledTimes(2);

      const [cancelEvent, cancelMgr] = mockOutbox.enqueue.mock.calls[0];
      expect(cancelEvent.eventType).toBe('SubscriptionCancelled');
      expect(cancelEvent.subscriptionId).toBe('sub-001');
      expect(cancelMgr).toBe(mockManager);

      const [projectionEvent, projectionMgr] = mockOutbox.enqueue.mock.calls[1];
      expect(projectionEvent.eventType).toBe('TenantSubscriptionChanged');
      expect(projectionEvent.subscriptionStatus).toBe(SubscriptionStatus.CANCELLED);
      expect(projectionMgr).toBe(mockManager);
    });

    it('should propagate enqueue failure so the cancellation rolls back', async () => {
      mockOutbox.enqueue.mockRejectedValue(new Error('outbox down'));

      await expect(handler.execute(buildCommand())).rejects.toThrow('outbox down');
    });
  });

  // ADR-0014: the admin NATS path dispatches this command now instead of
  // running a raw `UPDATE billing.subscriptions` that told Stripe nothing.
  // Its `cancelImmediately` choice had to survive the move.
  describe('immediate vs period-end cancellation (ADR-0014)', () => {
    it('ends the subscription now and tells Stripe to cancel now', async () => {
      const subscription = buildSubscription({ stripeSubscriptionId: 'sub_live_123' });
      mockSubscriptionRepo.findOne.mockResolvedValue(subscription);
      mockManager.findOne.mockResolvedValue(subscription);

      const before = Date.now();
      const saved = (await handler.execute(
        buildCommand('Fraud', 'sub-001', 'tenant-001', 'user-001', true),
      )) as Subscription;

      expect(mockStripe.cancelSubscription.mock.calls[0][0].immediately).toBe(true);
      // Not the period end the customer paid through: the service ends now.
      expect(saved.endDate!.getTime()).toBeGreaterThanOrEqual(before);
    });

    it('defaults to period end, which is what the customer paid for', async () => {
      const subscription = buildSubscription({ stripeSubscriptionId: 'sub_live_123' });
      mockSubscriptionRepo.findOne.mockResolvedValue(subscription);
      mockManager.findOne.mockResolvedValue(subscription);

      const saved = (await handler.execute(buildCommand())) as Subscription;

      expect(mockStripe.cancelSubscription.mock.calls[0][0].immediately).toBe(false);
      expect(saved.endDate).toEqual(subscription.currentPeriodEnd);
    });

    it('distinguishes the two in the Stripe idempotency key', async () => {
      // A fresh row per call: cancelling mutates the subscription, and a
      // second cancel of the same object would be refused for its status.
      const fresh = () => buildSubscription({ stripeSubscriptionId: 'sub_live_123' });
      mockSubscriptionRepo.findOne.mockImplementation(() => Promise.resolve(fresh()));
      mockManager.findOne.mockImplementation(() => Promise.resolve(fresh()));

      await handler.execute(buildCommand());
      await handler.execute(
        buildCommand('Fraud', 'sub-001', 'tenant-001', 'user-001', true),
      );

      const [scheduled, immediate] = mockStripe.cancelSubscription.mock.calls.map(
        (call: [{ idempotencyKey: string }]) => call[0].idempotencyKey,
      );
      // A shared key would make Stripe replay the scheduled cancellation and
      // silently ignore the immediate one.
      expect(scheduled).not.toBe(immediate);
    });
  });
});