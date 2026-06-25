/**
 * RefundPaymentHandler Unit Tests
 *
 * Tests the CQRS command handler for refunding payments including:
 * - Refundable status gating
 * - Double-refund prevention (over-refund guard)
 * - Invoice reconciliation after refund
 * - Transactional outbox publishing (event commits atomically with the refund)
 */

import Decimal from 'decimal.js';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { StripeApiService } from '@aquaculture/backend-common/billing';
import { OutboxPublisher } from '@platform/outbox';
import { DataSource } from 'typeorm';
import { RefundPaymentHandler } from '../handlers/refund-payment.handler';
import { RefundPaymentCommand } from '../commands/refund-payment.command';
import { RefundPaymentInput } from '../dto/refund-payment.input';
import { Payment, PaymentStatus, PaymentMethod } from '../entities/payment.entity';
import { Invoice, InvoiceStatus } from '../entities/invoice.entity';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildPayment(overrides: Partial<Payment> = {}): Partial<Payment> {
  return {
    id: 'pay-001',
    tenantId: 'tenant-001',
    transactionId: 'TXN-1',
    invoiceId: 'inv-001',
    amount: new Decimal(200),
    currency: 'USD',
    status: PaymentStatus.SUCCEEDED,
    paymentMethod: PaymentMethod.CREDIT_CARD,
    refundedAmount: new Decimal(0),
    refunds: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    version: 1,
    ...overrides,
  };
}

function buildInvoice(overrides: Partial<Invoice> = {}): Partial<Invoice> {
  return {
    id: 'inv-001',
    tenantId: 'tenant-001',
    invoiceNumber: 'INV-202603-T001-ABC',
    status: InvoiceStatus.PAID,
    total: new Decimal(200),
    amountPaid: new Decimal(200),
    amountDue: new Decimal(0),
    currency: 'USD',
    issueDate: new Date('2026-03-01'),
    dueDate: new Date('2026-03-31'),
    periodStart: new Date('2026-03-01'),
    periodEnd: new Date('2026-03-31'),
    lineItems: [],
    subtotal: new Decimal(200),
    createdAt: new Date(),
    updatedAt: new Date(),
    version: 1,
    ...overrides,
  };
}

function buildInput(overrides: Partial<RefundPaymentInput> = {}): RefundPaymentInput {
  return {
    paymentId: 'pay-001',
    amount: 200,
    reason: 'Customer request',
    ...overrides,
  };
}

function buildCommand(
  inputOverrides: Partial<RefundPaymentInput> = {},
  tenantId = 'tenant-001',
  userId = 'user-001',
): RefundPaymentCommand {
  return new RefundPaymentCommand(tenantId, buildInput(inputOverrides), userId);
}

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function createMockManager(payment: Partial<Payment> | null, invoice: Partial<Invoice> | null) {
  const manager = {
    findOne: jest.fn().mockImplementation((entity: unknown) => {
      if (entity === Payment) return Promise.resolve(payment);
      if (entity === Invoice) return Promise.resolve(invoice);
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

describe('RefundPaymentHandler', () => {
  let handler: RefundPaymentHandler;
  let mockManager: ReturnType<typeof createMockManager>;
  let mockDS: ReturnType<typeof createMockDataSource>;
  let mockOutbox: { enqueue: jest.Mock };
  let mockStripe: { createRefund: jest.Mock };
  let defaultPayment: Partial<Payment>;
  let defaultInvoice: Partial<Invoice>;

  beforeEach(async () => {
    defaultPayment = buildPayment();
    defaultInvoice = buildInvoice();
    mockManager = createMockManager(defaultPayment, defaultInvoice);
    mockDS = createMockDataSource(mockManager);
    mockOutbox = { enqueue: jest.fn().mockResolvedValue(undefined) };
    mockStripe = {
      createRefund: jest.fn().mockResolvedValue({
        id: 're_stripe_real',
        chargeId: 'ch_x',
        amount: 0n,
        currency: 'usd',
        status: 'succeeded',
        reason: null,
      }),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        RefundPaymentHandler,
        { provide: DataSource, useValue: mockDS },
        { provide: OutboxPublisher, useValue: mockOutbox },
        { provide: StripeApiService, useValue: mockStripe },
      ],
    }).compile();

    handler = moduleRef.get(RefundPaymentHandler);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Stripe refund (SSOT-C-12)', () => {
    it('issues a real Stripe refund and persists the Stripe refund id when a charge is linked', async () => {
      defaultPayment.stripeChargeId = 'ch_live_123';

      const result = await handler.execute(buildCommand({ amount: 10 }));

      expect(mockStripe.createRefund).toHaveBeenCalledTimes(1);
      const args = mockStripe.createRefund.mock.calls[0][0];
      expect(args.chargeId).toBe('ch_live_123');
      expect(args.reason).toBe('requested_by_customer');
      expect(typeof args.amount).toBe('bigint');
      expect(result.refunds?.[result.refunds.length - 1]?.refundId).toBe('re_stripe_real');
    });

    it('skips Stripe when the payment has no Stripe charge (legacy/manual)', async () => {
      // default payment has no stripeChargeId
      await handler.execute(buildCommand({ amount: 10 }));
      expect(mockStripe.createRefund).not.toHaveBeenCalled();
    });

    it('does NOT persist a refund when the Stripe refund fails (fail-closed)', async () => {
      defaultPayment.stripeChargeId = 'ch_live_123';
      mockStripe.createRefund.mockRejectedValue(new Error('stripe refund failed'));

      await expect(handler.execute(buildCommand({ amount: 10 }))).rejects.toThrow();
      expect(mockOutbox.enqueue).not.toHaveBeenCalled();
    });
  });

  describe('Successful refund', () => {
    it('should fully refund a succeeded payment and set status REFUNDED', async () => {
      const result = await handler.execute(buildCommand({ amount: 200 }));

      expect(result.status).toBe(PaymentStatus.REFUNDED);
      expect(result.refundedAmount.toNumber()).toBe(200);
    });

    it('should partially refund and set status PARTIALLY_REFUNDED', async () => {
      const result = await handler.execute(buildCommand({ amount: 50 }));

      expect(result.status).toBe(PaymentStatus.PARTIALLY_REFUNDED);
      expect(result.refundedAmount.toNumber()).toBe(50);
    });
  });

  describe('Refund validation', () => {
    it('should reject refund for a payment that is not found', async () => {
      mockManager.findOne.mockImplementation((entity: unknown) =>
        entity === Payment ? Promise.resolve(null) : Promise.resolve(defaultInvoice),
      );

      await expect(handler.execute(buildCommand())).rejects.toThrow(NotFoundException);
    });

    it('should reject refund exceeding the maximum refundable amount', async () => {
      await expect(handler.execute(buildCommand({ amount: 250 }))).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should reject refund for a non-refundable payment status', async () => {
      defaultPayment.status = PaymentStatus.FAILED;

      await expect(handler.execute(buildCommand({ amount: 50 }))).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('Transactional outbox publishing', () => {
    it('should enqueue PaymentRefunded into the outbox on the transactional manager', async () => {
      await handler.execute(buildCommand({ amount: 100 }));

      expect(mockOutbox.enqueue).toHaveBeenCalledTimes(1);
      const [event, mgr] = mockOutbox.enqueue.mock.calls[0];
      expect(event.eventType).toBe('PaymentRefunded');
      expect(event.paymentId).toBe('pay-001');
      expect(event.refundAmount).toBe(100);
      expect(event.currency).toBe('USD');
      // The event row must be enqueued on the SAME transactional manager so it
      // commits atomically with the refund + invoice writes — no fire-and-forget.
      expect(mgr).toBe(mockManager);
    });

    it('should propagate enqueue failure so the refund transaction rolls back', async () => {
      mockOutbox.enqueue.mockRejectedValue(new Error('outbox down'));

      // A financial event must never be silently dropped: if it cannot be
      // enqueued, the whole refund is rolled back rather than committed eventless.
      await expect(handler.execute(buildCommand({ amount: 100 }))).rejects.toThrow('outbox down');
    });
  });
});
