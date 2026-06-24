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
): CancelSubscriptionCommand {
  return new CancelSubscriptionCommand(tenantId, subscriptionId, reason, userId);
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
  let defaultSubscription: Partial<Subscription>;

  beforeEach(async () => {
    defaultSubscription = buildSubscription();
    mockManager = createMockManager(defaultSubscription);
    mockDS = createMockDataSource(mockManager);
    mockOutbox = { enqueue: jest.fn().mockResolvedValue(undefined) };

    const moduleRef = await Test.createTestingModule({
      providers: [
        CancelSubscriptionHandler,
        { provide: DataSource, useValue: mockDS },
        { provide: OutboxPublisher, useValue: mockOutbox },
      ],
    }).compile();

    handler = moduleRef.get(CancelSubscriptionHandler);
  });

  afterEach(() => {
    jest.clearAllMocks();
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
});
