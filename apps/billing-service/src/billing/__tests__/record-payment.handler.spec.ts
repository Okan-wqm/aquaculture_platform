/**
 * RecordPaymentHandler Unit Tests
 *
 * Tests the CQRS command handler for recording payments including:
 * - Currency mismatch validation
 * - Overpayment prevention
 * - Safe decimal arithmetic (safeAdd / safeSubtract)
 * - Partial vs full payment status transitions
 * - Tenant isolation (IDOR prevention)
 * - Invoice status gating (only payable statuses accepted)
 */

import Decimal from 'decimal.js';
import {
  NotFoundException,
  BadRequestException,
  InternalServerErrorException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { OutboxPublisher } from '@platform/outbox';
import { DataSource, EntityManager } from 'typeorm';
import { RecordPaymentHandler } from '../../billing/handlers/record-payment.handler';
import { RecordPaymentCommand } from '../../billing/commands/record-payment.command';
import { RecordPaymentInput } from '../../billing/dto/record-payment.input';
import { Payment, PaymentStatus, PaymentMethod } from '../../billing/entities/payment.entity';
import { Invoice, InvoiceStatus } from '../../billing/entities/invoice.entity';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildInvoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: 'inv-001',
    tenantId: 'tenant-001',
    invoiceNumber: 'INV-202603-T001-ABC',
    status: InvoiceStatus.SENT,
    total: new Decimal('200'),
    amountPaid: new Decimal('0'),
    amountDue: new Decimal('200'),
    currency: 'USD',
    issueDate: new Date('2026-03-01'),
    dueDate: new Date('2026-03-31'),
    periodStart: new Date('2026-03-01'),
    periodEnd: new Date('2026-03-31'),
    lineItems: [],
    billingAddress: {
      companyName: 'Test',
      street: '',
      city: '',
      state: '',
      postalCode: '',
      country: '',
    },
    subtotal: new Decimal('200'),
    createdAt: new Date(),
    updatedAt: new Date(),
    version: 1,
    ...overrides,
  } as Invoice;
}

function buildInput(overrides: Partial<RecordPaymentInput> = {}): RecordPaymentInput {
  return {
    invoiceId: 'inv-001',
    amount: 200,
    paymentMethod: PaymentMethod.CREDIT_CARD,
    ...overrides,
  } as RecordPaymentInput;
}

function buildCommand(
  inputOverrides: Partial<RecordPaymentInput> = {},
  tenantId = 'tenant-001',
  userId = 'user-001',
): RecordPaymentCommand {
  return new RecordPaymentCommand(tenantId, buildInput(inputOverrides), userId);
}

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function createMockManager(invoiceResult: Invoice | null) {
  const savedPayments: any[] = [];
  const savedInvoices: any[] = [];

  const manager = {
    findOne: jest.fn().mockImplementation((entity: any, opts: any) => {
      if (entity === Invoice) return Promise.resolve(invoiceResult);
      return Promise.resolve(null);
    }),
    create: jest.fn().mockImplementation((_entity: any, data: any) => ({
      ...data,
      id: 'pay-uuid-001',
    })),
    save: jest.fn().mockImplementation((entity: any, data: any) => {
      if (entity === Payment) {
        savedPayments.push(data);
        return Promise.resolve({ ...data, id: data.id || 'pay-uuid-001' });
      }
      if (entity === Invoice) {
        savedInvoices.push(data);
        return Promise.resolve(data);
      }
      return Promise.resolve(data);
    }),
    _savedPayments: savedPayments,
    _savedInvoices: savedInvoices,
  };
  return manager;
}

function createMockDataSource(
  manager: ReturnType<typeof createMockManager>,
): jest.Mocked<Partial<DataSource>> {
  return {
    transaction: jest.fn().mockImplementation(async (cb: (mgr: EntityManager) => Promise<any>) => {
      return cb(manager as unknown as EntityManager);
    }),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RecordPaymentHandler', () => {
  let handler: RecordPaymentHandler;
  let mockManager: ReturnType<typeof createMockManager>;
  let mockDS: ReturnType<typeof createMockDataSource>;
  let mockOutbox: { enqueue: jest.Mock };
  let defaultInvoice: Invoice;

  beforeEach(async () => {
    defaultInvoice = buildInvoice();
    mockManager = createMockManager(defaultInvoice);
    mockDS = createMockDataSource(mockManager);
    mockOutbox = { enqueue: jest.fn().mockResolvedValue(undefined) };

    // DI-provided mocks (useValue is untyped) avoid hand-written casts on the
    // handler's DataSource + OutboxPublisher dependencies.
    const moduleRef = await Test.createTestingModule({
      providers: [
        RecordPaymentHandler,
        { provide: DataSource, useValue: mockDS },
        { provide: OutboxPublisher, useValue: mockOutbox },
      ],
    }).compile();

    handler = moduleRef.get(RecordPaymentHandler);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // ==========================================================================
  // SUCCESSFUL PAYMENT
  // ==========================================================================

  describe('Successful payment recording', () => {
    it('should record a full payment and set invoice to PAID', async () => {
      const result = await handler.execute(buildCommand({ amount: 200 }));

      expect(result).toBeDefined();
      expect(result.amount.toString()).toBe('200');
      expect(result.status).toBe(PaymentStatus.SUCCEEDED);
      expect(result.tenantId).toBe('tenant-001');

      // Invoice should be marked as PAID
      expect(defaultInvoice.status).toBe(InvoiceStatus.PAID);
      expect(defaultInvoice.amountPaid.toString()).toBe('200');
      expect(defaultInvoice.amountDue.toString()).toBe('0');
      expect(defaultInvoice.paidAt).toBeDefined();
    });

    it('should record a partial payment and set invoice to PARTIALLY_PAID', async () => {
      const result = await handler.execute(buildCommand({ amount: 50 }));

      expect(result).toBeDefined();
      expect(result.amount.toString()).toBe('50');

      expect(defaultInvoice.status).toBe(InvoiceStatus.PARTIALLY_PAID);
      expect(defaultInvoice.amountPaid.toString()).toBe('50');
      expect(defaultInvoice.amountDue.toString()).toBe('150');
    });

    it('should use invoice currency when payment currency is not specified', async () => {
      const result = await handler.execute(buildCommand({ amount: 100 }));

      expect(result.currency).toBe('USD');
    });

    it('should generate a transaction ID with TXN prefix', async () => {
      const result = await handler.execute(buildCommand({ amount: 100 }));

      expect(result.transactionId).toMatch(/^TXN-/);
    });

    it('should accept payment on PENDING invoice', async () => {
      defaultInvoice.status = InvoiceStatus.PENDING;

      const result = await handler.execute(buildCommand({ amount: 100 }));

      expect(result).toBeDefined();
    });

    it('should accept payment on OVERDUE invoice', async () => {
      defaultInvoice.status = InvoiceStatus.OVERDUE;

      const result = await handler.execute(buildCommand({ amount: 100 }));

      expect(result).toBeDefined();
    });

    it('should accept payment on PARTIALLY_PAID invoice', async () => {
      defaultInvoice.status = InvoiceStatus.PARTIALLY_PAID;
      defaultInvoice.amountPaid = new Decimal(100);
      defaultInvoice.amountDue = new Decimal(100);

      const result = await handler.execute(buildCommand({ amount: 100 }));

      expect(result).toBeDefined();
      expect(defaultInvoice.status).toBe(InvoiceStatus.PAID);
      expect(defaultInvoice.amountDue.toString()).toBe('0');
    });
  });

  // ==========================================================================
  // CURRENCY MISMATCH
  // ==========================================================================

  describe('Currency mismatch validation', () => {
    it('should reject payment when currency does not match invoice currency', async () => {
      await expect(handler.execute(buildCommand({ amount: 100, currency: 'EUR' }))).rejects.toThrow(
        BadRequestException,
      );
      await expect(handler.execute(buildCommand({ amount: 100, currency: 'EUR' }))).rejects.toThrow(
        'Payment currency EUR does not match invoice currency USD',
      );
    });

    it('should accept payment when currency matches invoice currency explicitly', async () => {
      const result = await handler.execute(buildCommand({ amount: 100, currency: 'USD' }));

      expect(result).toBeDefined();
    });
  });

  // ==========================================================================
  // OVERPAYMENT PREVENTION
  // ==========================================================================

  describe('Overpayment prevention', () => {
    it('should reject payment amount exceeding amount due', async () => {
      await expect(handler.execute(buildCommand({ amount: 250 }))).rejects.toThrow(
        BadRequestException,
      );
      await expect(handler.execute(buildCommand({ amount: 250 }))).rejects.toThrow(
        'Payment amount 250.00 USD exceeds amount due 200.00 USD',
      );
    });

    it('should accept payment exactly equal to amount due', async () => {
      const result = await handler.execute(buildCommand({ amount: 200 }));

      expect(result).toBeDefined();
      expect(defaultInvoice.status).toBe(InvoiceStatus.PAID);
    });

    it('should fail closed when persisted amountDue is non-finite', async () => {
      defaultInvoice.amountDue = new Decimal(Number.NaN);

      await expect(handler.execute(buildCommand({ amount: 100 }))).rejects.toThrow(
        InternalServerErrorException,
      );
      await expect(handler.execute(buildCommand({ amount: 100 }))).rejects.toThrow(
        'has invalid amount due value',
      );
    });
  });

  // ==========================================================================
  // SAFE DECIMAL ARITHMETIC
  // ==========================================================================

  describe('Safe decimal arithmetic', () => {
    it('should handle 0.1 + 0.2 correctly (classic floating point trap)', async () => {
      // Invoice: total=0.30, amountPaid=0.10, amountDue=0.20
      Object.assign(defaultInvoice, {
        total: new Decimal('0.3'),
        amountPaid: new Decimal('0.1'),
        amountDue: new Decimal('0.2'),
      });

      await handler.execute(buildCommand({ amount: 0.2 }));

      // With raw floating point: 0.1 + 0.2 = 0.30000000000000004
      // With safeAdd: should be exactly 0.3
      expect(defaultInvoice.amountPaid.toString()).toBe('0.3');
      expect(defaultInvoice.amountDue.toString()).toBe('0');
      expect(defaultInvoice.status).toBe(InvoiceStatus.PAID);
    });

    it('should calculate partial payment math correctly with decimals', async () => {
      Object.assign(defaultInvoice, {
        total: new Decimal('99.99'),
        amountPaid: new Decimal('0'),
        amountDue: new Decimal('99.99'),
      });

      await handler.execute(buildCommand({ amount: 33.33 }));

      expect(defaultInvoice.amountPaid.toString()).toBe('33.33');
      expect(defaultInvoice.amountDue.toString()).toBe('66.66');
      expect(defaultInvoice.status).toBe(InvoiceStatus.PARTIALLY_PAID);
    });

    it('should close an invoice when the exact minor-unit remainder is paid', async () => {
      Object.assign(defaultInvoice, {
        total: new Decimal('100'),
        amountPaid: new Decimal('99.99'),
        amountDue: new Decimal('0.01'),
      });

      await handler.execute(buildCommand({ amount: 0.01 }));

      expect(defaultInvoice.status).toBe(InvoiceStatus.PAID);
      expect(defaultInvoice.amountDue.toString()).toBe('0');
    });

    it('should not produce negative amountDue', async () => {
      Object.assign(defaultInvoice, {
        total: new Decimal('100'),
        amountPaid: new Decimal('0'),
        amountDue: new Decimal('100'),
      });

      await handler.execute(buildCommand({ amount: 100 }));

      expect(defaultInvoice.amountDue.isNegative()).toBe(false);
    });
  });

  // ==========================================================================
  // TENANT ISOLATION (IDOR PREVENTION)
  // ==========================================================================

  describe('Tenant isolation (IDOR prevention)', () => {
    it('should not find invoice belonging to a different tenant', async () => {
      // The handler passes { id: input.invoiceId, tenantId } to findOne.
      // If tenantId doesn't match, the invoice won't be found.
      mockManager.findOne.mockResolvedValue(null);

      await expect(
        handler.execute(buildCommand({ invoiceId: 'inv-001' }, 'tenant-999')),
      ).rejects.toThrow(NotFoundException);
    });

    it('should verify findOne includes tenantId in the WHERE clause', async () => {
      mockManager.findOne.mockResolvedValue(null);

      try {
        await handler.execute(buildCommand({}, 'tenant-001'));
      } catch {
        // expected NotFoundException if invoice not found
      }

      expect(mockManager.findOne).toHaveBeenCalledWith(
        Invoice,
        expect.objectContaining({
          where: { id: 'inv-001', tenantId: 'tenant-001' },
          lock: { mode: 'pessimistic_write' },
        }),
      );
    });
  });

  // ==========================================================================
  // INVOICE STATUS GATING
  // ==========================================================================

  describe('Invoice status gating', () => {
    const nonPayableStatuses = [
      InvoiceStatus.DRAFT,
      InvoiceStatus.PAID,
      InvoiceStatus.VOID,
      InvoiceStatus.REFUNDED,
    ];

    it.each(nonPayableStatuses)(
      'should reject payment for invoice with status %s',
      async (status) => {
        defaultInvoice.status = status;

        await expect(handler.execute(buildCommand({ amount: 100 }))).rejects.toThrow(
          BadRequestException,
        );
        await expect(handler.execute(buildCommand({ amount: 100 }))).rejects.toThrow(
          `Cannot record payment for invoice with status ${status}`,
        );
      },
    );
  });

  // ==========================================================================
  // TRANSACTIONAL OUTBOX PUBLISHING
  // ==========================================================================

  describe('Transactional outbox publishing', () => {
    it('should enqueue PaymentReceived into the outbox within the transaction', async () => {
      await handler.execute(buildCommand({ amount: 100 }));

      expect(mockOutbox.enqueue).toHaveBeenCalledTimes(1);
      const [event, mgr] = mockOutbox.enqueue.mock.calls[0];
      expect(event.paymentId).toBe('pay-uuid-001');
      expect(event.invoiceId).toBe('inv-001');
      expect(event.amount).toBe(100);
      expect(event.currency).toBe('USD');
      // The event row must be enqueued on the SAME transactional manager so it
      // commits atomically with the payment + invoice writes — no fire-and-forget.
      expect(mgr).toBe(mockManager);
    });

    it('should propagate enqueue failure so the payment transaction rolls back', async () => {
      mockOutbox.enqueue.mockRejectedValue(new Error('outbox down'));

      // A financial event must never be silently dropped: if it cannot be
      // enqueued, the whole payment is rolled back rather than committed eventless.
      await expect(handler.execute(buildCommand({ amount: 100 }))).rejects.toThrow('outbox down');
    });
  });
});
