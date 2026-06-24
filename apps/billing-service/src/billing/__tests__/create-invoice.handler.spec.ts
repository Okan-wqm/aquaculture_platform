/**
 * CreateInvoiceHandler Unit Tests
 *
 * Tests the CQRS command handler for creating invoices including:
 * - Subscription-existence (IDOR) validation
 * - Line-item / discount validation
 * - Atomic persistence + transactional outbox publishing
 */

import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { OutboxPublisher } from '@platform/outbox';
import { DataSource } from 'typeorm';
import { CreateInvoiceHandler } from '../handlers/create-invoice.handler';
import { CreateInvoiceCommand } from '../commands/create-invoice.command';
import { CreateInvoiceInput } from '../dto/create-invoice.input';
import { Invoice } from '../entities/invoice.entity';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildInput(overrides: Partial<CreateInvoiceInput> = {}): CreateInvoiceInput {
  return {
    billingAddress: {
      companyName: 'Acme',
      street: '1 Main',
      city: 'Town',
      state: 'ST',
      postalCode: '00000',
      country: 'US',
    },
    lineItems: [
      { description: 'Service', quantity: 2, unitPrice: 50 },
    ],
    currency: 'USD',
    dueDate: '2026-04-30',
    periodStart: '2026-03-01',
    periodEnd: '2026-03-31',
    ...overrides,
  } as CreateInvoiceInput;
}

function buildCommand(
  inputOverrides: Partial<CreateInvoiceInput> = {},
  tenantId = 'tenant-001',
  userId = 'user-001',
): CreateInvoiceCommand {
  return new CreateInvoiceCommand(tenantId, buildInput(inputOverrides), userId);
}

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function createMockManager() {
  const manager = {
    create: jest.fn().mockImplementation((_entity: unknown, data: Record<string, unknown>) => ({
      ...data,
      id: 'inv-uuid-001',
    })),
    save: jest.fn().mockImplementation((_entity: unknown, data: unknown) => Promise.resolve(data)),
  };
  return manager;
}

function createMockDataSource(
  manager: ReturnType<typeof createMockManager>,
  subscriptionExists: boolean,
) {
  return {
    // Used by TenantScopedRepository.create for the subscription-existence check.
    getRepository: jest.fn().mockReturnValue({
      metadata: { columns: [{ propertyName: 'tenantId' }] },
      findOne: jest.fn().mockResolvedValue(subscriptionExists ? { id: 'sub-001' } : null),
    }),
    transaction: jest.fn().mockImplementation(
      (cb: (mgr: typeof manager) => Promise<unknown>) => cb(manager),
    ),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CreateInvoiceHandler', () => {
  let handler: CreateInvoiceHandler;
  let mockManager: ReturnType<typeof createMockManager>;
  let mockDS: ReturnType<typeof createMockDataSource>;
  let mockOutbox: { enqueue: jest.Mock };

  async function buildHandler(subscriptionExists = true): Promise<void> {
    mockManager = createMockManager();
    mockDS = createMockDataSource(mockManager, subscriptionExists);
    mockOutbox = { enqueue: jest.fn().mockResolvedValue(undefined) };

    const moduleRef = await Test.createTestingModule({
      providers: [
        CreateInvoiceHandler,
        { provide: DataSource, useValue: mockDS },
        { provide: OutboxPublisher, useValue: mockOutbox },
      ],
    }).compile();

    handler = moduleRef.get(CreateInvoiceHandler);
  }

  beforeEach(async () => {
    await buildHandler();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Successful invoice creation', () => {
    it('should create a DRAFT invoice with computed totals', async () => {
      const result = await handler.execute(buildCommand());

      expect(result.id).toBe('inv-uuid-001');
      expect(result.total.toNumber()).toBe(100);
      expect(mockManager.save).toHaveBeenCalledWith(Invoice, expect.objectContaining({ id: 'inv-uuid-001' }));
    });
  });

  describe('Validation', () => {
    it('should reject when no line items are provided', async () => {
      await expect(handler.execute(buildCommand({ lineItems: [] }))).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should reject when the subscription does not belong to the tenant', async () => {
      await buildHandler(false);

      await expect(
        handler.execute(buildCommand({ subscriptionId: '550e8400-e29b-41d4-a716-446655440000' })),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('Transactional outbox publishing', () => {
    it('should save the invoice and enqueue InvoiceGenerated in one transaction', async () => {
      await handler.execute(buildCommand());

      // The save and the outbox enqueue must run on the SAME transactional
      // manager so the event commits atomically with the invoice row.
      expect(mockDS.transaction).toHaveBeenCalledTimes(1);
      expect(mockOutbox.enqueue).toHaveBeenCalledTimes(1);

      const [event, mgr] = mockOutbox.enqueue.mock.calls[0];
      expect(event.eventType).toBe('InvoiceGenerated');
      expect(event.invoiceId).toBe('inv-uuid-001');
      expect(event.total).toBe(100);
      expect(event.currency).toBe('USD');
      expect(mgr).toBe(mockManager);
    });

    it('should propagate enqueue failure so the invoice creation rolls back', async () => {
      mockOutbox.enqueue.mockRejectedValue(new Error('outbox down'));

      await expect(handler.execute(buildCommand())).rejects.toThrow('outbox down');
    });
  });
});
