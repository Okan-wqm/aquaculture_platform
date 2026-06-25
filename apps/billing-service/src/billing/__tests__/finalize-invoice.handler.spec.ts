/**
 * FinalizeInvoiceHandler Unit Tests
 *
 * - DRAFT → SENT state machine + status gating
 * - W1.1 (SSOT-C-12): a Stripe-mirrored invoice is finalized at Stripe too,
 *   fail-closed (Stripe failure leaves the invoice DRAFT).
 */

import { NotFoundException, BadRequestException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { StripeApiService } from '@aquaculture/backend-common/billing';
import { DataSource } from 'typeorm';
import { FinalizeInvoiceHandler } from '../handlers/finalize-invoice.handler';
import { FinalizeInvoiceCommand } from '../commands/finalize-invoice.command';
import { Invoice, InvoiceStatus } from '../entities/invoice.entity';

function buildInvoice(overrides: Partial<Invoice> = {}): Partial<Invoice> {
  return {
    id: 'inv-001',
    tenantId: 'tenant-001',
    status: InvoiceStatus.DRAFT,
    ...overrides,
  };
}

function createMockManager(invoice: Partial<Invoice> | null) {
  return {
    findOne: jest.fn().mockResolvedValue(invoice),
    save: jest.fn().mockImplementation((_entity: unknown, data: unknown) => Promise.resolve(data)),
  };
}

describe('FinalizeInvoiceHandler', () => {
  let handler: FinalizeInvoiceHandler;
  let mockManager: ReturnType<typeof createMockManager>;
  let mockDS: { transaction: jest.Mock };
  let mockStripe: { finalizeInvoice: jest.Mock };
  let invoice: Partial<Invoice>;

  const cmd = (): FinalizeInvoiceCommand =>
    new FinalizeInvoiceCommand('tenant-001', 'inv-001', 'user-001');

  beforeEach(async () => {
    invoice = buildInvoice();
    mockManager = createMockManager(invoice);
    mockDS = {
      transaction: jest.fn().mockImplementation(
        (cb: (mgr: typeof mockManager) => Promise<unknown>) => cb(mockManager),
      ),
    };
    mockStripe = {
      finalizeInvoice: jest.fn().mockResolvedValue({
        id: 'in_test',
        status: 'open',
        hostedInvoiceUrl: null,
      }),
    };

    const ref = await Test.createTestingModule({
      providers: [
        FinalizeInvoiceHandler,
        { provide: DataSource, useValue: mockDS },
        { provide: StripeApiService, useValue: mockStripe },
      ],
    }).compile();

    handler = ref.get(FinalizeInvoiceHandler);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('finalizes a DRAFT invoice to SENT', async () => {
    const result = await handler.execute(cmd());
    expect(result.status).toBe(InvoiceStatus.SENT);
  });

  it('rejects a non-DRAFT invoice', async () => {
    invoice.status = InvoiceStatus.SENT;
    await expect(handler.execute(cmd())).rejects.toThrow(BadRequestException);
  });

  it('rejects when the invoice is not found', async () => {
    mockManager.findOne.mockResolvedValue(null);
    await expect(handler.execute(cmd())).rejects.toThrow(NotFoundException);
  });

  describe('Stripe finalize (SSOT-C-12)', () => {
    it('finalizes at Stripe when the invoice is mirrored (has a stripeInvoiceId)', async () => {
      invoice.stripeInvoiceId = 'in_live_1';

      await handler.execute(cmd());

      expect(mockStripe.finalizeInvoice).toHaveBeenCalledTimes(1);
      const args = mockStripe.finalizeInvoice.mock.calls[0][0];
      expect(args.invoiceId).toBe('in_live_1');
      expect(args.idempotencyKey).toBe('invoice-finalize:in_live_1');
    });

    it('skips Stripe for a local-only invoice (no stripeInvoiceId)', async () => {
      await handler.execute(cmd());
      expect(mockStripe.finalizeInvoice).not.toHaveBeenCalled();
    });

    it('does NOT flip the invoice to SENT when the Stripe finalize fails (fail-closed)', async () => {
      invoice.stripeInvoiceId = 'in_live_1';
      mockStripe.finalizeInvoice.mockRejectedValue(new Error('stripe down'));

      await expect(handler.execute(cmd())).rejects.toThrow();
      expect(mockManager.save).not.toHaveBeenCalled();
    });
  });
});
