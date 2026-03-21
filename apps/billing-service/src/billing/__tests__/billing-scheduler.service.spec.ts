/**
 * BillingSchedulerService Unit Tests
 *
 * Tests the automated billing lifecycle scheduler including:
 * - D09-F02: Trial expiry (TRIAL -> ACTIVE transition)
 * - D09-F06: Overdue invoice detection (SENT/PENDING -> OVERDUE)
 * - D09-F03: Auto-invoice generation for expired billing periods
 * - Idempotency: duplicate invoice prevention
 * - Fault tolerance: one failure must not block remaining records
 */

import { Repository, LessThanOrEqual, LessThan, In } from 'typeorm';
import { BillingSchedulerService } from '../../billing/billing-scheduler.service';
import {
  Subscription,
  SubscriptionStatus,
  BillingCycle,
  PlanTier,
} from '../../billing/entities/subscription.entity';
import { Invoice, InvoiceStatus } from '../../billing/entities/invoice.entity';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PAST = new Date('2026-03-01T00:00:00Z');
const FUTURE = new Date('2026-06-01T00:00:00Z');

function buildSubscription(overrides: Partial<Subscription> = {}): Subscription {
  return {
    id: 'sub-001',
    tenantId: 'tenant-001',
    planTier: PlanTier.PROFESSIONAL,
    planName: 'Professional',
    status: SubscriptionStatus.TRIAL,
    billingCycle: BillingCycle.MONTHLY,
    limits: {
      maxFarms: 10,
      maxPonds: 50,
      maxSensors: 200,
      maxUsers: 20,
      dataRetentionDays: 365,
      alertsEnabled: true,
      reportsEnabled: true,
      apiAccessEnabled: true,
      customIntegrationsEnabled: false,
    },
    pricing: {
      basePrice: 199,
      currency: 'USD',
    },
    startDate: new Date('2026-01-01'),
    currentPeriodStart: new Date('2026-02-01'),
    currentPeriodEnd: new Date('2026-03-01'),
    autoRenew: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    version: 1,
    sanitize: jest.fn(),
    ...overrides,
  } as unknown as Subscription;
}

function buildInvoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: 'inv-001',
    tenantId: 'tenant-001',
    invoiceNumber: 'INV-202603-T001',
    subscriptionId: 'sub-001',
    status: InvoiceStatus.SENT,
    total: 199,
    subtotal: 199,
    amountPaid: 0,
    amountDue: 199,
    currency: 'USD',
    issueDate: new Date('2026-02-01'),
    dueDate: new Date('2026-03-01'),
    periodStart: new Date('2026-02-01'),
    periodEnd: new Date('2026-03-01'),
    lineItems: [],
    billingAddress: { companyName: 'Test', street: '', city: '', state: '', postalCode: '', country: '' },
    createdAt: new Date(),
    updatedAt: new Date(),
    version: 1,
    validatePdfUrl: jest.fn(),
    ...overrides,
  } as unknown as Invoice;
}

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function createMockSubscriptionRepo(): jest.Mocked<Partial<Repository<Subscription>>> {
  return {
    find: jest.fn().mockResolvedValue([]),
    save: jest.fn().mockImplementation((entity: any) => Promise.resolve(entity)),
  };
}

function createMockInvoiceRepo(): jest.Mocked<Partial<Repository<Invoice>>> {
  return {
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue(null),
    create: jest.fn().mockImplementation((data: any) => ({ ...data, id: 'new-inv-001' })),
    save: jest.fn().mockImplementation((entity: any) => Promise.resolve({ ...entity, id: entity.id || 'new-inv-001' })),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('BillingSchedulerService', () => {
  let service: BillingSchedulerService;
  let subRepo: ReturnType<typeof createMockSubscriptionRepo>;
  let invRepo: ReturnType<typeof createMockInvoiceRepo>;
  let mockEventBus: { publish: jest.Mock };

  beforeEach(() => {
    subRepo = createMockSubscriptionRepo();
    invRepo = createMockInvoiceRepo();
    mockEventBus = { publish: jest.fn().mockResolvedValue(undefined) };

    service = new BillingSchedulerService(
      subRepo as unknown as Repository<Subscription>,
      invRepo as unknown as Repository<Invoice>,
      mockEventBus as any,
    );

    // Fix "now" for deterministic tests
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-03-14T12:00:00Z'));
  });

  afterEach(() => {
    jest.clearAllMocks();
    jest.useRealTimers();
  });

  // ==========================================================================
  // D09-F02: TRIAL EXPIRY
  // ==========================================================================

  describe('handleTrialExpiry (D09-F02)', () => {
    it('should transition expired TRIAL subscriptions to ACTIVE when payment method exists', async () => {
      const expiredTrial = buildSubscription({
        status: SubscriptionStatus.TRIAL,
        trialEndDate: PAST,
        stripeCustomerId: 'cus_123',
      });
      (subRepo.find as jest.Mock).mockResolvedValue([expiredTrial]);

      await service.handleTrialExpiry();

      expect(expiredTrial.status).toBe(SubscriptionStatus.ACTIVE);
      expect(subRepo.save).toHaveBeenCalledWith(expiredTrial);
    });

    it('should transition to PAST_DUE when no payment method (stripeCustomerId) exists', async () => {
      const expiredTrial = buildSubscription({
        status: SubscriptionStatus.TRIAL,
        trialEndDate: PAST,
        // no stripeCustomerId
      });
      (subRepo.find as jest.Mock).mockResolvedValue([expiredTrial]);

      await service.handleTrialExpiry();

      expect(expiredTrial.status).toBe(SubscriptionStatus.PAST_DUE);
      expect(subRepo.save).toHaveBeenCalledWith(expiredTrial);
    });

    it('should update billing period start/end on transition to ACTIVE', async () => {
      const expiredTrial = buildSubscription({
        status: SubscriptionStatus.TRIAL,
        trialEndDate: PAST,
        billingCycle: BillingCycle.MONTHLY,
        stripeCustomerId: 'cus_123',
      });
      (subRepo.find as jest.Mock).mockResolvedValue([expiredTrial]);

      await service.handleTrialExpiry();

      const now = new Date('2026-03-14T12:00:00Z');
      expect(expiredTrial.currentPeriodStart).toEqual(now);
      // Monthly = 1 month later
      expect(expiredTrial.currentPeriodEnd.getMonth()).toBe(now.getMonth() + 1);
    });

    it('should NOT update billing period when transitioning to PAST_DUE', async () => {
      const originalStart = new Date('2026-02-01');
      const originalEnd = new Date('2026-03-01');
      const expiredTrial = buildSubscription({
        status: SubscriptionStatus.TRIAL,
        trialEndDate: PAST,
        currentPeriodStart: originalStart,
        currentPeriodEnd: originalEnd,
        // no stripeCustomerId
      });
      (subRepo.find as jest.Mock).mockResolvedValue([expiredTrial]);

      await service.handleTrialExpiry();

      expect(expiredTrial.status).toBe(SubscriptionStatus.PAST_DUE);
      expect(expiredTrial.currentPeriodStart).toEqual(originalStart);
      expect(expiredTrial.currentPeriodEnd).toEqual(originalEnd);
    });

    it('should NOT transition trials whose trialEndDate is in the future', async () => {
      // This is verified through the query filter — repo.find returns nothing
      (subRepo.find as jest.Mock).mockResolvedValue([]);

      await service.handleTrialExpiry();

      expect(subRepo.save).not.toHaveBeenCalled();
    });

    it('should query for TRIAL status and trialEndDate <= now', async () => {
      (subRepo.find as jest.Mock).mockResolvedValue([]);

      await service.handleTrialExpiry();

      expect(subRepo.find).toHaveBeenCalledWith({
        where: {
          status: SubscriptionStatus.TRIAL,
          trialEndDate: expect.anything(), // LessThanOrEqual(now)
        },
      });
    });

    it('should process multiple expired trials independently', async () => {
      const trial1 = buildSubscription({ id: 'sub-001', trialEndDate: PAST, stripeCustomerId: 'cus_1' });
      const trial2 = buildSubscription({ id: 'sub-002', tenantId: 'tenant-002', trialEndDate: PAST, stripeCustomerId: 'cus_2' });
      (subRepo.find as jest.Mock).mockResolvedValue([trial1, trial2]);

      await service.handleTrialExpiry();

      expect(trial1.status).toBe(SubscriptionStatus.ACTIVE);
      expect(trial2.status).toBe(SubscriptionStatus.ACTIVE);
      expect(subRepo.save).toHaveBeenCalledTimes(2);
    });

    it('should continue processing remaining trials if one fails (fault tolerance)', async () => {
      const trial1 = buildSubscription({ id: 'sub-001', trialEndDate: PAST, stripeCustomerId: 'cus_1' });
      const trial2 = buildSubscription({ id: 'sub-002', tenantId: 'tenant-002', trialEndDate: PAST, stripeCustomerId: 'cus_2' });
      (subRepo.find as jest.Mock).mockResolvedValue([trial1, trial2]);

      // First save fails, second succeeds
      (subRepo.save as jest.Mock)
        .mockRejectedValueOnce(new Error('DB write error'))
        .mockResolvedValueOnce(trial2);

      await service.handleTrialExpiry();

      // trial2 should still have been processed
      expect(trial2.status).toBe(SubscriptionStatus.ACTIVE);
      expect(subRepo.save).toHaveBeenCalledTimes(2);
    });

    it('should do nothing when no expired trials exist', async () => {
      (subRepo.find as jest.Mock).mockResolvedValue([]);

      await service.handleTrialExpiry();

      expect(subRepo.save).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // SUBSCRIPTION EXPIRY (HIGH-3)
  // ==========================================================================

  describe('handleSubscriptionExpiry (HIGH-3)', () => {
    it('should expire ACTIVE subscriptions with endDate past the 3-day grace period', async () => {
      const expiredSub = buildSubscription({
        status: SubscriptionStatus.ACTIVE,
        endDate: new Date('2026-03-10T00:00:00Z'), // 4+ days ago (now is March 14)
      });
      (subRepo.find as jest.Mock).mockResolvedValue([expiredSub]);

      await service.handleSubscriptionExpiry();

      expect(expiredSub.status).toBe(SubscriptionStatus.EXPIRED);
      expect(subRepo.save).toHaveBeenCalledWith(expiredSub);
    });

    it('should NOT expire subscriptions still within the 3-day grace period', async () => {
      // endDate is March 12, which is only 2 days ago — within grace period
      (subRepo.find as jest.Mock).mockResolvedValue([]);

      await service.handleSubscriptionExpiry();

      expect(subRepo.save).not.toHaveBeenCalled();
    });

    it('should process multiple expired subscriptions independently', async () => {
      const sub1 = buildSubscription({ id: 'sub-001', status: SubscriptionStatus.ACTIVE, endDate: new Date('2026-03-01') });
      const sub2 = buildSubscription({ id: 'sub-002', tenantId: 'tenant-002', status: SubscriptionStatus.ACTIVE, endDate: new Date('2026-03-05') });
      (subRepo.find as jest.Mock).mockResolvedValue([sub1, sub2]);

      await service.handleSubscriptionExpiry();

      expect(sub1.status).toBe(SubscriptionStatus.EXPIRED);
      expect(sub2.status).toBe(SubscriptionStatus.EXPIRED);
      expect(subRepo.save).toHaveBeenCalledTimes(2);
    });

    it('should continue processing remaining subscriptions if one fails', async () => {
      const sub1 = buildSubscription({ id: 'sub-001', status: SubscriptionStatus.ACTIVE, endDate: new Date('2026-03-01') });
      const sub2 = buildSubscription({ id: 'sub-002', tenantId: 'tenant-002', status: SubscriptionStatus.ACTIVE, endDate: new Date('2026-03-01') });
      (subRepo.find as jest.Mock).mockResolvedValue([sub1, sub2]);

      (subRepo.save as jest.Mock)
        .mockRejectedValueOnce(new Error('DB error'))
        .mockResolvedValueOnce(sub2);

      await service.handleSubscriptionExpiry();

      expect(sub2.status).toBe(SubscriptionStatus.EXPIRED);
      expect(subRepo.save).toHaveBeenCalledTimes(2);
    });

    it('should do nothing when no expired subscriptions exist', async () => {
      (subRepo.find as jest.Mock).mockResolvedValue([]);

      await service.handleSubscriptionExpiry();

      expect(subRepo.save).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // D09-F06: OVERDUE INVOICE DETECTION
  // ==========================================================================

  describe('handleOverdueInvoices (D09-F06)', () => {
    it('should mark SENT invoices with past dueDate as OVERDUE', async () => {
      const overdueInv = buildInvoice({
        status: InvoiceStatus.SENT,
        dueDate: PAST,
      });
      (invRepo.find as jest.Mock).mockResolvedValue([overdueInv]);

      await service.handleOverdueInvoices();

      expect(overdueInv.status).toBe(InvoiceStatus.OVERDUE);
      expect(invRepo.save).toHaveBeenCalledWith(overdueInv);
    });

    it('should mark PENDING invoices with past dueDate as OVERDUE', async () => {
      const overdueInv = buildInvoice({
        status: InvoiceStatus.PENDING,
        dueDate: PAST,
      });
      (invRepo.find as jest.Mock).mockResolvedValue([overdueInv]);

      await service.handleOverdueInvoices();

      expect(overdueInv.status).toBe(InvoiceStatus.OVERDUE);
    });

    it('should NOT mark invoices whose dueDate is in the future', async () => {
      // Verified via query filter — repo.find returns nothing
      (invRepo.find as jest.Mock).mockResolvedValue([]);

      await service.handleOverdueInvoices();

      expect(invRepo.save).not.toHaveBeenCalled();
    });

    it('should query for SENT and PENDING statuses only', async () => {
      (invRepo.find as jest.Mock).mockResolvedValue([]);

      await service.handleOverdueInvoices();

      expect(invRepo.find).toHaveBeenCalledWith({
        where: {
          status: expect.anything(), // In([SENT, PENDING])
          dueDate: expect.anything(), // LessThan(now)
        },
      });
    });

    it('should process multiple overdue invoices independently', async () => {
      const inv1 = buildInvoice({ id: 'inv-001', status: InvoiceStatus.SENT, dueDate: PAST });
      const inv2 = buildInvoice({ id: 'inv-002', tenantId: 'tenant-002', status: InvoiceStatus.PENDING, dueDate: PAST });
      (invRepo.find as jest.Mock).mockResolvedValue([inv1, inv2]);

      await service.handleOverdueInvoices();

      expect(inv1.status).toBe(InvoiceStatus.OVERDUE);
      expect(inv2.status).toBe(InvoiceStatus.OVERDUE);
      expect(invRepo.save).toHaveBeenCalledTimes(2);
    });

    it('should continue processing remaining invoices if one fails (fault tolerance)', async () => {
      const inv1 = buildInvoice({ id: 'inv-001', status: InvoiceStatus.SENT, dueDate: PAST });
      const inv2 = buildInvoice({ id: 'inv-002', tenantId: 'tenant-002', status: InvoiceStatus.SENT, dueDate: PAST });
      (invRepo.find as jest.Mock).mockResolvedValue([inv1, inv2]);

      (invRepo.save as jest.Mock)
        .mockRejectedValueOnce(new Error('DB error'))
        .mockResolvedValueOnce(inv2);

      await service.handleOverdueInvoices();

      expect(inv2.status).toBe(InvoiceStatus.OVERDUE);
      expect(invRepo.save).toHaveBeenCalledTimes(2);
    });

    it('should do nothing when no overdue invoices exist', async () => {
      (invRepo.find as jest.Mock).mockResolvedValue([]);

      await service.handleOverdueInvoices();

      expect(invRepo.save).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // D09-F03: AUTO-INVOICE GENERATION
  // ==========================================================================

  describe('generateMonthlyInvoices (D09-F03)', () => {
    it('should generate an invoice for ACTIVE subscription with expired period', async () => {
      const activeSub = buildSubscription({
        status: SubscriptionStatus.ACTIVE,
        currentPeriodStart: new Date('2026-02-01'),
        currentPeriodEnd: new Date('2026-03-01'), // past
        pricing: { basePrice: 199, currency: 'USD' },
      });
      (subRepo.find as jest.Mock).mockResolvedValue([activeSub]);
      (invRepo.findOne as jest.Mock).mockResolvedValue(null); // no existing invoice

      await service.generateMonthlyInvoices();

      expect(invRepo.create).toHaveBeenCalledTimes(1);
      expect(invRepo.save).toHaveBeenCalled();

      const createdInvoice = (invRepo.create as jest.Mock).mock.calls[0][0];
      expect(createdInvoice.tenantId).toBe('tenant-001');
      expect(createdInvoice.subscriptionId).toBe('sub-001');
      expect(createdInvoice.status).toBe(InvoiceStatus.PENDING);
      expect(createdInvoice.total).toBe(199);
      expect(createdInvoice.amountDue).toBe(199);
      expect(createdInvoice.currency).toBe('USD');
    });

    it('should set due date 30 days from now', async () => {
      const activeSub = buildSubscription({
        status: SubscriptionStatus.ACTIVE,
        currentPeriodEnd: PAST,
      });
      (subRepo.find as jest.Mock).mockResolvedValue([activeSub]);
      (invRepo.findOne as jest.Mock).mockResolvedValue(null);

      await service.generateMonthlyInvoices();

      const createdInvoice = (invRepo.create as jest.Mock).mock.calls[0][0];
      const expectedDue = new Date('2026-03-14T12:00:00Z');
      expectedDue.setDate(expectedDue.getDate() + 30);
      expect(createdInvoice.dueDate.toISOString()).toBe(expectedDue.toISOString());
    });

    it('should advance subscription period after generating invoice', async () => {
      const activeSub = buildSubscription({
        status: SubscriptionStatus.ACTIVE,
        currentPeriodStart: new Date('2026-02-01'),
        currentPeriodEnd: new Date('2026-03-01'),
        billingCycle: BillingCycle.MONTHLY,
      });
      (subRepo.find as jest.Mock).mockResolvedValue([activeSub]);
      (invRepo.findOne as jest.Mock).mockResolvedValue(null);

      await service.generateMonthlyInvoices();

      // Period should advance: new start = old end, new end = old end + 1 month
      expect(activeSub.currentPeriodStart).toEqual(new Date('2026-03-01'));
      expect(activeSub.currentPeriodEnd.getMonth()).toBe(3); // April
    });

    it('should multiply base price by cycle months for non-monthly billing', async () => {
      const quarterlySub = buildSubscription({
        status: SubscriptionStatus.ACTIVE,
        currentPeriodEnd: PAST,
        billingCycle: BillingCycle.QUARTERLY,
        pricing: { basePrice: 100, currency: 'USD' },
      });
      (subRepo.find as jest.Mock).mockResolvedValue([quarterlySub]);
      (invRepo.findOne as jest.Mock).mockResolvedValue(null);

      await service.generateMonthlyInvoices();

      const createdInvoice = (invRepo.create as jest.Mock).mock.calls[0][0];
      expect(createdInvoice.total).toBe(300); // 100 * 3
    });

    it('should generate invoice number with INV- prefix', async () => {
      const activeSub = buildSubscription({
        status: SubscriptionStatus.ACTIVE,
        currentPeriodEnd: PAST,
      });
      (subRepo.find as jest.Mock).mockResolvedValue([activeSub]);
      (invRepo.findOne as jest.Mock).mockResolvedValue(null);

      await service.generateMonthlyInvoices();

      const createdInvoice = (invRepo.create as jest.Mock).mock.calls[0][0];
      expect(createdInvoice.invoiceNumber).toMatch(/^INV-/);
    });

    // --- Idempotency ---

    it('should skip invoice generation if one already exists for the same period (idempotency)', async () => {
      const activeSub = buildSubscription({
        status: SubscriptionStatus.ACTIVE,
        currentPeriodStart: new Date('2026-02-01'),
        currentPeriodEnd: new Date('2026-03-01'),
      });
      (subRepo.find as jest.Mock).mockResolvedValue([activeSub]);

      // Existing invoice for this exact period
      (invRepo.findOne as jest.Mock).mockResolvedValue(
        buildInvoice({
          subscriptionId: 'sub-001',
          periodStart: new Date('2026-02-01'),
          periodEnd: new Date('2026-03-01'),
        }),
      );

      await service.generateMonthlyInvoices();

      // create should NOT have been called
      expect(invRepo.create).not.toHaveBeenCalled();
    });

    it('should still advance period even when invoice already exists (prevent stuck loop)', async () => {
      const activeSub = buildSubscription({
        status: SubscriptionStatus.ACTIVE,
        currentPeriodStart: new Date('2026-02-01'),
        currentPeriodEnd: new Date('2026-03-01'),
        billingCycle: BillingCycle.MONTHLY,
      });
      (subRepo.find as jest.Mock).mockResolvedValue([activeSub]);
      (invRepo.findOne as jest.Mock).mockResolvedValue(buildInvoice());

      await service.generateMonthlyInvoices();

      // Period should still advance
      expect(activeSub.currentPeriodStart).toEqual(new Date('2026-03-01'));
      // subRepo.save called for period advance
      expect(subRepo.save).toHaveBeenCalled();
    });

    // --- Fault tolerance ---

    it('should continue generating invoices for remaining subscriptions if one fails', async () => {
      const sub1 = buildSubscription({
        id: 'sub-001',
        tenantId: 'tenant-001',
        status: SubscriptionStatus.ACTIVE,
        currentPeriodEnd: PAST,
      });
      const sub2 = buildSubscription({
        id: 'sub-002',
        tenantId: 'tenant-002',
        status: SubscriptionStatus.ACTIVE,
        currentPeriodEnd: PAST,
      });
      (subRepo.find as jest.Mock).mockResolvedValue([sub1, sub2]);
      (invRepo.findOne as jest.Mock).mockResolvedValue(null);

      // First invoice save fails, second succeeds
      (invRepo.save as jest.Mock)
        .mockRejectedValueOnce(new Error('DB constraint violation'))
        .mockResolvedValue({ id: 'new-inv-002' });

      await service.generateMonthlyInvoices();

      // invRepo.create should have been called twice (both attempted)
      expect(invRepo.create).toHaveBeenCalledTimes(2);
    });

    it('should do nothing when no subscriptions are due for invoicing', async () => {
      (subRepo.find as jest.Mock).mockResolvedValue([]);

      await service.generateMonthlyInvoices();

      expect(invRepo.create).not.toHaveBeenCalled();
      expect(invRepo.save).not.toHaveBeenCalled();
    });

    // --- NATS event publishing ---

    it('should publish InvoiceGenerated event after auto-invoice creation', async () => {
      const activeSub = buildSubscription({
        status: SubscriptionStatus.ACTIVE,
        currentPeriodEnd: PAST,
      });
      (subRepo.find as jest.Mock).mockResolvedValue([activeSub]);
      (invRepo.findOne as jest.Mock).mockResolvedValue(null);

      await service.generateMonthlyInvoices();

      expect(mockEventBus.publish).toHaveBeenCalledTimes(1);
      const event = mockEventBus.publish.mock.calls[0][0];
      expect(event.invoiceId).toBeDefined();
      expect(event.subscriptionId).toBe('sub-001');
      expect(event.currency).toBe('USD');
    });

    it('should not fail if NATS event publishing fails', async () => {
      const activeSub = buildSubscription({
        status: SubscriptionStatus.ACTIVE,
        currentPeriodEnd: PAST,
      });
      (subRepo.find as jest.Mock).mockResolvedValue([activeSub]);
      (invRepo.findOne as jest.Mock).mockResolvedValue(null);
      mockEventBus.publish.mockRejectedValue(new Error('NATS down'));

      // Should not throw
      await expect(service.generateMonthlyInvoices()).resolves.not.toThrow();
    });
  });

  // ==========================================================================
  // CURRENCY ROUNDING
  // ==========================================================================

  describe('Currency rounding', () => {
    it('should round invoice totals to 2 decimal places', async () => {
      const activeSub = buildSubscription({
        status: SubscriptionStatus.ACTIVE,
        currentPeriodEnd: PAST,
        pricing: { basePrice: 33.333, currency: 'USD' },
      });
      (subRepo.find as jest.Mock).mockResolvedValue([activeSub]);
      (invRepo.findOne as jest.Mock).mockResolvedValue(null);

      await service.generateMonthlyInvoices();

      const createdInvoice = (invRepo.create as jest.Mock).mock.calls[0][0];
      expect(createdInvoice.total).toBe(33.33);
      expect(createdInvoice.subtotal).toBe(33.33);
      expect(createdInvoice.amountDue).toBe(33.33);
    });
  });

  // ==========================================================================
  // BILLING CYCLE PERIOD ADVANCEMENT
  // ==========================================================================

  describe('Period advancement for various billing cycles', () => {
    it.each([
      { cycle: BillingCycle.MONTHLY, label: 'monthly', expectedMonthDelta: 1 },
      { cycle: BillingCycle.QUARTERLY, label: 'quarterly', expectedMonthDelta: 3 },
      { cycle: BillingCycle.SEMI_ANNUAL, label: 'semi-annual', expectedMonthDelta: 6 },
      { cycle: BillingCycle.ANNUAL, label: 'annual', expectedMonthDelta: 12 },
    ])(
      'should advance period by $expectedMonthDelta month(s) for $label cycle',
      async ({ cycle, expectedMonthDelta }) => {
        const sub = buildSubscription({
          status: SubscriptionStatus.ACTIVE,
          currentPeriodStart: new Date('2026-01-01'),
          currentPeriodEnd: new Date('2026-03-01'),
          billingCycle: cycle,
        });
        (subRepo.find as jest.Mock).mockResolvedValue([sub]);
        (invRepo.findOne as jest.Mock).mockResolvedValue(null);

        await service.generateMonthlyInvoices();

        // New start = old end (March 1)
        expect(sub.currentPeriodStart).toEqual(new Date('2026-03-01'));
        // New end = March 1 + expectedMonthDelta months
        const expectedEnd = new Date('2026-03-01');
        expectedEnd.setMonth(expectedEnd.getMonth() + expectedMonthDelta);
        expect(sub.currentPeriodEnd.getFullYear()).toBe(expectedEnd.getFullYear());
        expect(sub.currentPeriodEnd.getMonth()).toBe(expectedEnd.getMonth());
      },
    );
  });
});
