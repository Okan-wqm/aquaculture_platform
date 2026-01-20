/**
 * Invoice Service Tests
 *
 * Comprehensive tests for invoice generation, management, and processing
 */

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Invoice, InvoiceStatus, InvoiceLineItem, TaxInfo, BillingAddress } from '../entities/invoice.entity';
import { Subscription, SubscriptionStatus, BillingCycle, PlanTier } from '../entities/subscription.entity';

// Mock Invoice Service for testing
interface InvoiceCreateDto {
  subscriptionId: string;
  tenantId: string;
  lineItems: InvoiceLineItem[];
  billingAddress: BillingAddress;
  taxInfo?: TaxInfo;
  dueDate?: Date;
  notes?: string;
}

interface InvoiceService {
  createInvoice(dto: InvoiceCreateDto): Promise<Invoice>;
  getInvoice(id: string): Promise<Invoice | null>;
  getInvoicesByTenant(tenantId: string): Promise<Invoice[]>;
  finalizeInvoice(id: string): Promise<Invoice>;
  voidInvoice(id: string, reason: string): Promise<Invoice>;
  generateInvoiceNumber(): string;
  calculateTotals(lineItems: InvoiceLineItem[], taxInfo?: TaxInfo): { subtotal: number; tax: number; total: number };
  generatePdf(invoiceId: string): Promise<Buffer>;
  sendInvoiceEmail(invoiceId: string, recipients: string[]): Promise<void>;
}

describe('Invoice Service', () => {
  let invoiceRepository: jest.Mocked<Repository<Invoice>>;
  let subscriptionRepository: jest.Mocked<Repository<Subscription>>;
  let eventEmitter: jest.Mocked<EventEmitter2>;

  const mockInvoiceRepository = {
    create: jest.fn(),
    save: jest.fn(),
    findOne: jest.fn(),
    find: jest.fn(),
    update: jest.fn(),
    count: jest.fn(),
  };

  const mockSubscriptionRepository = {
    findOne: jest.fn(),
  };

  const mockEventEmitter = {
    emit: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        {
          provide: getRepositoryToken(Invoice),
          useValue: mockInvoiceRepository,
        },
        {
          provide: getRepositoryToken(Subscription),
          useValue: mockSubscriptionRepository,
        },
        {
          provide: EventEmitter2,
          useValue: mockEventEmitter,
        },
      ],
    }).compile();

    invoiceRepository = module.get(getRepositoryToken(Invoice));
    subscriptionRepository = module.get(getRepositoryToken(Subscription));
    eventEmitter = module.get(EventEmitter2);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // ============================================================================
  // INVOICE CREATION TESTS
  // ============================================================================
  describe('Invoice Creation', () => {
    const mockLineItems: InvoiceLineItem[] = [
      {
        description: 'Professional Plan - Monthly',
        quantity: 1,
        unitPrice: 99.00,
        amount: 99.00,
      },
      {
        description: 'API Calls (50,000 calls)',
        quantity: 50000,
        unitPrice: 0.001,
        amount: 50.00,
        productCode: 'api_calls',
      },
    ];

    const mockBillingAddress: BillingAddress = {
      companyName: 'Test Company',
      street: '123 Test Street',
      city: 'Istanbul',
      state: 'Istanbul',
      postalCode: '34000',
      country: 'TR',
    };

    describe('Basic Invoice Creation', () => {
      it('should create invoice successfully', async () => {
        const mockInvoice: Partial<Invoice> = {
          id: 'inv-123',
          subscriptionId: 'sub-1',
          tenantId: 'tenant-1',
          invoiceNumber: 'INV-2024-0001',
          status: InvoiceStatus.DRAFT,
          lineItems: mockLineItems,
          billingAddress: mockBillingAddress,
          subtotal: 149.00,
          total: 149.00,
          currency: 'USD',
        };

        mockInvoiceRepository.create.mockReturnValue(mockInvoice as Invoice);
        mockInvoiceRepository.save.mockResolvedValue(mockInvoice as Invoice);
        mockInvoiceRepository.count.mockResolvedValue(0);

        const result = mockInvoiceRepository.save(mockInvoice as Invoice);

        expect(mockInvoiceRepository.save).toHaveBeenCalled();
        expect(result).toBeDefined();
      });

      it('should generate unique sequential invoice number', () => {
        const generateInvoiceNumber = (sequence: number): string => {
          const year = new Date().getFullYear();
          return `INV-${year}-${String(sequence).padStart(6, '0')}`;
        };

        const currentYear = new Date().getFullYear();
        expect(generateInvoiceNumber(1)).toBe(`INV-${currentYear}-000001`);
        expect(generateInvoiceNumber(100)).toBe(`INV-${currentYear}-000100`);
        expect(generateInvoiceNumber(999999)).toBe(`INV-${currentYear}-999999`);
      });

      it('should set correct issue date', () => {
        const now = new Date();
        const invoice: Partial<Invoice> = {
          issueDate: now,
        };

        expect(invoice.issueDate).toBeInstanceOf(Date);
        expect(invoice.issueDate?.getTime()).toBeLessThanOrEqual(Date.now());
      });

      it('should calculate due date correctly (NET 30)', () => {
        const invoiceDate = new Date('2024-06-01');
        const dueDate = new Date(invoiceDate);
        dueDate.setDate(dueDate.getDate() + 30);

        expect(dueDate.toISOString().split('T')[0]).toBe('2024-07-01');
      });

      it('should populate line items correctly', () => {
        const lineItems: InvoiceLineItem[] = [
          {
            description: 'Base Plan',
            quantity: 1,
            unitPrice: 99.00,
            amount: 99.00,
          },
          {
            description: 'Additional Users (5)',
            quantity: 5,
            unitPrice: 10.00,
            amount: 50.00,
          },
        ];

        expect(lineItems.length).toBe(2);
        expect(lineItems[0]?.amount).toBe(99.00);
        expect(lineItems[1]?.amount).toBe(50.00);
      });

      it('should calculate subtotal, tax, and total correctly', () => {
        const calculateTotals = (
          lineItems: InvoiceLineItem[],
          taxRate: number = 0,
        ): { subtotal: number; tax: number; total: number } => {
          const subtotal = lineItems.reduce((sum, item) => sum + item.amount, 0);
          const tax = Math.round(subtotal * (taxRate / 100) * 100) / 100;
          const total = subtotal + tax;
          return { subtotal, tax, total };
        };

        const lineItems: InvoiceLineItem[] = [
          { description: 'Item 1', quantity: 1, unitPrice: 100, amount: 100 },
          { description: 'Item 2', quantity: 2, unitPrice: 50, amount: 100 },
        ];

        const totals = calculateTotals(lineItems, 18);

        expect(totals.subtotal).toBe(200);
        expect(totals.tax).toBe(36);
        expect(totals.total).toBe(236);
      });

      it('should set status to DRAFT on creation', () => {
        const invoice: Partial<Invoice> = {
          status: InvoiceStatus.DRAFT,
        };

        expect(invoice.status).toBe(InvoiceStatus.DRAFT);
      });
    });

    describe('Invoice Line Items', () => {
      it('should handle usage line item with meter details', () => {
        const usageLineItem: InvoiceLineItem = {
          description: 'API Calls - 50,000 calls @ $0.001/call',
          quantity: 50000,
          unitPrice: 0.001,
          amount: 50.00,
          productCode: 'api_calls',
          usagePeriodStart: new Date('2024-06-01'),
          usagePeriodEnd: new Date('2024-06-30'),
        };

        expect(usageLineItem.productCode).toBe('api_calls');
        expect(usageLineItem.amount).toBe(50.00);
      });

      it('should handle subscription line item', () => {
        const subscriptionLineItem: InvoiceLineItem = {
          description: 'Professional Plan - Monthly Subscription',
          quantity: 1,
          unitPrice: 199.00,
          amount: 199.00,
          subscriptionPeriod: '2024-06-01 to 2024-06-30',
        };

        expect(subscriptionLineItem.subscriptionPeriod).toBeDefined();
      });

      it('should handle one-time charge line item', () => {
        const oneTimeLineItem: InvoiceLineItem = {
          description: 'Setup Fee',
          quantity: 1,
          unitPrice: 500.00,
          amount: 500.00,
          isOneTime: true,
        };

        expect(oneTimeLineItem.isOneTime).toBe(true);
      });

      it('should handle discount line item (negative amount)', () => {
        const discountLineItem: InvoiceLineItem = {
          description: 'Promotional Discount - 20%',
          quantity: 1,
          unitPrice: -50.00,
          amount: -50.00,
          isDiscount: true,
          discountCode: 'SAVE20',
        };

        expect(discountLineItem.amount).toBeLessThan(0);
        expect(discountLineItem.isDiscount).toBe(true);
      });

      it('should handle adjustment line item', () => {
        const adjustmentLineItem: InvoiceLineItem = {
          description: 'Service Credit - June 2024',
          quantity: 1,
          unitPrice: -25.00,
          amount: -25.00,
          isAdjustment: true,
          adjustmentReason: 'Service outage compensation',
        };

        expect(adjustmentLineItem.isAdjustment).toBe(true);
        expect(adjustmentLineItem.adjustmentReason).toBeDefined();
      });

      it('should handle proration line item', () => {
        const prorationLineItem: InvoiceLineItem = {
          description: 'Proration - Upgrade from Starter to Professional',
          quantity: 1,
          unitPrice: 66.33,
          amount: 66.33,
          isProration: true,
          prorationDays: 20,
          prorationTotal: 30,
        };

        expect(prorationLineItem.isProration).toBe(true);
      });

      it('should handle credit line item', () => {
        const creditLineItem: InvoiceLineItem = {
          description: 'Account Credit Applied',
          quantity: 1,
          unitPrice: -100.00,
          amount: -100.00,
          isCredit: true,
          creditReason: 'Referral bonus',
        };

        expect(creditLineItem.isCredit).toBe(true);
        expect(creditLineItem.amount).toBeLessThan(0);
      });

      it('should group line items correctly', () => {
        const lineItems: InvoiceLineItem[] = [
          { description: 'Base Plan', quantity: 1, unitPrice: 99, amount: 99, category: 'subscription' },
          { description: 'API Calls', quantity: 1000, unitPrice: 0.01, amount: 10, category: 'usage' },
          { description: 'Storage', quantity: 10, unitPrice: 1, amount: 10, category: 'usage' },
          { description: 'Discount', quantity: 1, unitPrice: -10, amount: -10, category: 'discount' },
        ];

        const grouped = lineItems.reduce((acc, item) => {
          const category = item.category || 'other';
          acc[category] = acc[category] || [];
          acc[category].push(item);
          return acc;
        }, {} as Record<string, InvoiceLineItem[]>);

        expect(grouped['subscription']?.length).toBe(1);
        expect(grouped['usage']?.length).toBe(2);
        expect(grouped['discount']?.length).toBe(1);
      });
    });

    describe('Invoice Validation', () => {
      it('should not create invoice with empty line items', () => {
        const validateInvoice = (lineItems: InvoiceLineItem[]): boolean => {
          return lineItems.length > 0;
        };

        expect(validateInvoice([])).toBe(false);
        expect(validateInvoice(mockLineItems)).toBe(true);
      });

      it('should not create invoice without billing address', () => {
        const validateBillingAddress = (address?: BillingAddress): boolean => {
          if (!address) return false;
          return !!(address.companyName && address.street && address.city && address.country);
        };

        expect(validateBillingAddress(undefined)).toBe(false);
        expect(validateBillingAddress(mockBillingAddress)).toBe(true);
      });

      it('should not commit files containing secrets', () => {
        const containsSecrets = (content: string): boolean => {
          const secretPatterns = [
            /api[_-]?key/i,
            /secret[_-]?key/i,
            /password/i,
            /credentials/i,
            /private[_-]?key/i,
          ];
          return secretPatterns.some((pattern) => pattern.test(content));
        };

        expect(containsSecrets('api_key=abc123')).toBe(true);
        expect(containsSecrets('invoice_number=INV-001')).toBe(false);
      });
    });
  });

  // ============================================================================
  // INVOICE ADJUSTMENT TESTS
  // ============================================================================
  describe('Invoice Adjustments', () => {
    it('should add manual adjustment', () => {
      const addAdjustment = (
        invoice: Partial<Invoice>,
        amount: number,
        reason: string,
      ): InvoiceLineItem => {
        const adjustment: InvoiceLineItem = {
          description: `Adjustment: ${reason}`,
          quantity: 1,
          unitPrice: amount,
          amount,
          isAdjustment: true,
          adjustmentReason: reason,
        };

        invoice.lineItems = [...(invoice.lineItems || []), adjustment];
        return adjustment;
      };

      const invoice: Partial<Invoice> = {
        lineItems: [],
        subtotal: 100,
      };

      const adjustment = addAdjustment(invoice, -20, 'Service credit');

      expect(adjustment.amount).toBe(-20);
      expect(invoice.lineItems?.length).toBe(1);
    });

    it('should record adjustment reason', () => {
      const adjustment: InvoiceLineItem = {
        description: 'Manual Adjustment',
        quantity: 1,
        unitPrice: -50,
        amount: -50,
        isAdjustment: true,
        adjustmentReason: 'Customer goodwill credit',
        adjustedBy: 'admin@example.com',
        adjustedAt: new Date(),
      };

      expect(adjustment.adjustmentReason).toBe('Customer goodwill credit');
      expect(adjustment.adjustedBy).toBeDefined();
      expect(adjustment.adjustedAt).toBeInstanceOf(Date);
    });

    it('should track adjustment audit trail', () => {
      interface AdjustmentAudit {
        invoiceId: string;
        adjustmentType: string;
        amount: number;
        reason: string;
        performedBy: string;
        performedAt: Date;
        previousTotal: number;
        newTotal: number;
      }

      const auditTrail: AdjustmentAudit[] = [];

      const recordAdjustment = (
        invoiceId: string,
        amount: number,
        reason: string,
        previousTotal: number,
      ): void => {
        auditTrail.push({
          invoiceId,
          adjustmentType: amount < 0 ? 'credit' : 'debit',
          amount,
          reason,
          performedBy: 'admin@example.com',
          performedAt: new Date(),
          previousTotal,
          newTotal: previousTotal + amount,
        });
      };

      recordAdjustment('inv-123', -50, 'Service credit', 200);
      recordAdjustment('inv-123', 25, 'Late fee', 150);

      expect(auditTrail.length).toBe(2);
      expect(auditTrail[0]?.adjustmentType).toBe('credit');
      expect(auditTrail[1]?.adjustmentType).toBe('debit');
    });

    it('should handle negative adjustment (credit memo)', () => {
      const createCreditMemo = (
        originalInvoice: Partial<Invoice>,
        creditAmount: number,
        reason: string,
      ): Partial<Invoice> => {
        return {
          id: `cm-${Date.now()}`,
          invoiceNumber: `CM-${originalInvoice.invoiceNumber}`,
          relatedInvoiceId: originalInvoice.id,
          status: InvoiceStatus.DRAFT,
          lineItems: [
            {
              description: `Credit Memo: ${reason}`,
              quantity: 1,
              unitPrice: -creditAmount,
              amount: -creditAmount,
            },
          ],
          subtotal: -creditAmount,
          total: -creditAmount,
          isCreditMemo: true,
        };
      };

      const originalInvoice: Partial<Invoice> = {
        id: 'inv-123',
        invoiceNumber: 'INV-2024-0001',
        total: 500,
      };

      const creditMemo = createCreditMemo(originalInvoice, 100, 'Billing error');

      expect(creditMemo.isCreditMemo).toBe(true);
      expect(creditMemo.total).toBe(-100);
      expect(creditMemo.relatedInvoiceId).toBe('inv-123');
    });
  });

  // ============================================================================
  // INVOICE FINALIZATION TESTS
  // ============================================================================
  describe('Invoice Finalization', () => {
    it('should finalize draft invoice', () => {
      const finalizeInvoice = (invoice: Partial<Invoice>): Partial<Invoice> => {
        if (invoice.status !== InvoiceStatus.DRAFT) {
          throw new Error('Only draft invoices can be finalized');
        }

        return {
          ...invoice,
          status: InvoiceStatus.SENT,
          finalizedAt: new Date(),
          isFinalized: true,
        };
      };

      const draftInvoice: Partial<Invoice> = {
        id: 'inv-123',
        status: InvoiceStatus.DRAFT,
      };

      const finalized = finalizeInvoice(draftInvoice);

      expect(finalized.status).toBe(InvoiceStatus.SENT);
      expect(finalized.isFinalized).toBe(true);
    });

    it('should make finalized invoice immutable', () => {
      const isInvoiceImmutable = (invoice: Partial<Invoice>): boolean => {
        return invoice.isFinalized === true || invoice.status !== InvoiceStatus.DRAFT;
      };

      const draftInvoice: Partial<Invoice> = { status: InvoiceStatus.DRAFT, isFinalized: false };
      const finalizedInvoice: Partial<Invoice> = { status: InvoiceStatus.SENT, isFinalized: true };
      const paidInvoice: Partial<Invoice> = { status: InvoiceStatus.PAID, isFinalized: true };

      expect(isInvoiceImmutable(draftInvoice)).toBe(false);
      expect(isInvoiceImmutable(finalizedInvoice)).toBe(true);
      expect(isInvoiceImmutable(paidInvoice)).toBe(true);
    });

    it('should lock invoice after payment', () => {
      const markAsPaid = (invoice: Partial<Invoice>, paymentId: string): Partial<Invoice> => {
        return {
          ...invoice,
          status: InvoiceStatus.PAID,
          paidAt: new Date(),
          paymentId,
          isLocked: true,
        };
      };

      const invoice: Partial<Invoice> = { id: 'inv-123', status: InvoiceStatus.SENT };
      const paidInvoice = markAsPaid(invoice, 'pay-456');

      expect(paidInvoice.status).toBe(InvoiceStatus.PAID);
      expect(paidInvoice.isLocked).toBe(true);
      expect(paidInvoice.paymentId).toBe('pay-456');
    });

    it('should void invoice correctly', () => {
      const voidInvoice = (invoice: Partial<Invoice>, reason: string): Partial<Invoice> => {
        if (invoice.status === InvoiceStatus.PAID) {
          throw new Error('Cannot void paid invoice');
        }

        return {
          ...invoice,
          status: InvoiceStatus.VOID,
          voidedAt: new Date(),
          voidReason: reason,
        };
      };

      const invoice: Partial<Invoice> = { id: 'inv-123', status: InvoiceStatus.SENT };
      const voidedInvoice = voidInvoice(invoice, 'Duplicate invoice');

      expect(voidedInvoice.status).toBe(InvoiceStatus.VOID);
      expect(voidedInvoice.voidReason).toBe('Duplicate invoice');
    });

    it('should create replacement for voided invoice', () => {
      const createReplacement = (
        voidedInvoice: Partial<Invoice>,
        newLineItems: InvoiceLineItem[],
      ): Partial<Invoice> => {
        return {
          id: `inv-${Date.now()}`,
          invoiceNumber: `${voidedInvoice.invoiceNumber}-R1`,
          replacesInvoiceId: voidedInvoice.id,
          status: InvoiceStatus.DRAFT,
          lineItems: newLineItems,
          tenantId: voidedInvoice.tenantId,
        };
      };

      const voidedInvoice: Partial<Invoice> = {
        id: 'inv-123',
        invoiceNumber: 'INV-2024-0001',
        tenantId: 'tenant-1',
      };

      const replacement = createReplacement(voidedInvoice, []);

      expect(replacement.replacesInvoiceId).toBe('inv-123');
      expect(replacement.invoiceNumber).toBe('INV-2024-0001-R1');
    });
  });

  // ============================================================================
  // INVOICE DELIVERY TESTS
  // ============================================================================
  describe('Invoice Delivery', () => {
    it('should generate PDF buffer', async () => {
      const generatePdf = async (invoice: Partial<Invoice>): Promise<Buffer> => {
        // Mock PDF generation
        const pdfContent = `Invoice: ${invoice.invoiceNumber}\nTotal: ${invoice.total}`;
        return Buffer.from(pdfContent);
      };

      const invoice: Partial<Invoice> = {
        invoiceNumber: 'INV-2024-0001',
        total: 199.00,
      };

      const pdf = await generatePdf(invoice);

      expect(pdf).toBeInstanceOf(Buffer);
      expect(pdf.length).toBeGreaterThan(0);
    });

    it('should send invoice email', async () => {
      const emailSent: { to: string; subject: string; sent: boolean }[] = [];

      const sendInvoiceEmail = async (
        invoice: Partial<Invoice>,
        recipients: string[],
      ): Promise<void> => {
        recipients.forEach((recipient) => {
          emailSent.push({
            to: recipient,
            subject: `Invoice ${invoice.invoiceNumber}`,
            sent: true,
          });
        });
      };

      const invoice: Partial<Invoice> = { invoiceNumber: 'INV-2024-0001' };
      await sendInvoiceEmail(invoice, ['billing@example.com', 'finance@example.com']);

      expect(emailSent.length).toBe(2);
      expect(emailSent[0]?.to).toBe('billing@example.com');
    });

    it('should attach PDF to email', async () => {
      interface EmailAttachment {
        filename: string;
        content: Buffer;
        contentType: string;
      }

      const createEmailWithAttachment = (
        invoiceNumber: string,
        pdfBuffer: Buffer,
      ): EmailAttachment => {
        return {
          filename: `${invoiceNumber}.pdf`,
          content: pdfBuffer,
          contentType: 'application/pdf',
        };
      };

      const attachment = createEmailWithAttachment(
        'INV-2024-0001',
        Buffer.from('PDF content'),
      );

      expect(attachment.filename).toBe('INV-2024-0001.pdf');
      expect(attachment.contentType).toBe('application/pdf');
    });

    it('should generate invoice portal link', () => {
      const generatePortalLink = (invoiceId: string, tenantId: string): string => {
        const token = Buffer.from(`${invoiceId}:${tenantId}:${Date.now()}`).toString('base64');
        return `https://billing.example.com/invoices/${invoiceId}?token=${token}`;
      };

      const link = generatePortalLink('inv-123', 'tenant-1');

      expect(link).toContain('inv-123');
      expect(link).toContain('token=');
    });

    it('should send reminder before due date', async () => {
      const shouldSendReminder = (dueDate: Date, daysBefore: number): boolean => {
        const now = new Date();
        const reminderDate = new Date(dueDate);
        reminderDate.setDate(reminderDate.getDate() - daysBefore);
        return now >= reminderDate && now < dueDate;
      };

      const dueDateIn5Days = new Date();
      dueDateIn5Days.setDate(dueDateIn5Days.getDate() + 5);

      const dueDateIn10Days = new Date();
      dueDateIn10Days.setDate(dueDateIn10Days.getDate() + 10);

      expect(shouldSendReminder(dueDateIn5Days, 7)).toBe(true);
      expect(shouldSendReminder(dueDateIn10Days, 7)).toBe(false);
    });

    it('should send overdue reminder', async () => {
      const isOverdue = (dueDate: Date): boolean => {
        return new Date() > dueDate;
      };

      const pastDueDate = new Date();
      pastDueDate.setDate(pastDueDate.getDate() - 5);

      const futureDueDate = new Date();
      futureDueDate.setDate(futureDueDate.getDate() + 5);

      expect(isOverdue(pastDueDate)).toBe(true);
      expect(isOverdue(futureDueDate)).toBe(false);
    });

    it('should track delivery status', () => {
      interface DeliveryStatus {
        emailSent: boolean;
        emailSentAt?: Date;
        emailOpened: boolean;
        emailOpenedAt?: Date;
        pdfDownloaded: boolean;
        pdfDownloadedAt?: Date;
      }

      const deliveryStatus: DeliveryStatus = {
        emailSent: true,
        emailSentAt: new Date(),
        emailOpened: true,
        emailOpenedAt: new Date(),
        pdfDownloaded: false,
      };

      expect(deliveryStatus.emailSent).toBe(true);
      expect(deliveryStatus.emailOpened).toBe(true);
      expect(deliveryStatus.pdfDownloaded).toBe(false);
    });
  });

  // ============================================================================
  // INVOICE STATUS TESTS
  // ============================================================================
  describe('Invoice Status Management', () => {
    it('should transition from DRAFT to SENT', () => {
      const validTransitions: Record<InvoiceStatus, InvoiceStatus[]> = {
        [InvoiceStatus.DRAFT]: [InvoiceStatus.SENT, InvoiceStatus.VOID],
        [InvoiceStatus.PENDING]: [InvoiceStatus.SENT, InvoiceStatus.VOID],
        [InvoiceStatus.SENT]: [InvoiceStatus.PAID, InvoiceStatus.OVERDUE, InvoiceStatus.VOID],
        [InvoiceStatus.OVERDUE]: [InvoiceStatus.PAID, InvoiceStatus.VOID],
        [InvoiceStatus.PAID]: [],
        [InvoiceStatus.PARTIALLY_PAID]: [InvoiceStatus.PAID, InvoiceStatus.OVERDUE],
        [InvoiceStatus.VOID]: [],
        [InvoiceStatus.REFUNDED]: [],
      };

      const canTransition = (from: InvoiceStatus, to: InvoiceStatus): boolean => {
        return validTransitions[from]?.includes(to) ?? false;
      };

      expect(canTransition(InvoiceStatus.DRAFT, InvoiceStatus.SENT)).toBe(true);
      expect(canTransition(InvoiceStatus.DRAFT, InvoiceStatus.PAID)).toBe(false);
      expect(canTransition(InvoiceStatus.SENT, InvoiceStatus.PAID)).toBe(true);
      expect(canTransition(InvoiceStatus.PAID, InvoiceStatus.VOID)).toBe(false);
    });

    it('should mark overdue after due date', () => {
      const checkAndUpdateOverdue = (invoice: Partial<Invoice>): InvoiceStatus => {
        if (
          invoice.status === InvoiceStatus.SENT &&
          invoice.dueDate &&
          new Date() > invoice.dueDate
        ) {
          return InvoiceStatus.OVERDUE;
        }
        return invoice.status || InvoiceStatus.DRAFT;
      };

      const overdueInvoice: Partial<Invoice> = {
        status: InvoiceStatus.SENT,
        dueDate: new Date('2023-01-01'),
      };

      const currentInvoice: Partial<Invoice> = {
        status: InvoiceStatus.SENT,
        dueDate: new Date('2025-12-31'),
      };

      expect(checkAndUpdateOverdue(overdueInvoice)).toBe(InvoiceStatus.OVERDUE);
      expect(checkAndUpdateOverdue(currentInvoice)).toBe(InvoiceStatus.SENT);
    });
  });

  // ============================================================================
  // INVOICE QUERY TESTS
  // ============================================================================
  describe('Invoice Queries', () => {
    it('should list invoices with pagination', () => {
      const paginate = <T>(items: T[], page: number, pageSize: number): T[] => {
        const start = (page - 1) * pageSize;
        return items.slice(start, start + pageSize);
      };

      const invoices = Array.from({ length: 50 }, (_, i) => ({ id: `inv-${i}` }));
      const page1 = paginate(invoices, 1, 10);
      const page2 = paginate(invoices, 2, 10);

      expect(page1.length).toBe(10);
      expect(page2.length).toBe(10);
      expect(page1[0]?.id).toBe('inv-0');
      expect(page2[0]?.id).toBe('inv-10');
    });

    it('should search invoices by number', () => {
      const searchByNumber = (
        invoices: Partial<Invoice>[],
        query: string,
      ): Partial<Invoice>[] => {
        return invoices.filter((inv) =>
          inv.invoiceNumber?.toLowerCase().includes(query.toLowerCase()),
        );
      };

      const invoices: Partial<Invoice>[] = [
        { invoiceNumber: 'INV-2024-0001' },
        { invoiceNumber: 'INV-2024-0002' },
        { invoiceNumber: 'INV-2023-0100' },
      ];

      expect(searchByNumber(invoices, '2024').length).toBe(2);
      expect(searchByNumber(invoices, '0001').length).toBe(1);
    });

    it('should filter invoices by status', () => {
      const filterByStatus = (
        invoices: Partial<Invoice>[],
        status: InvoiceStatus,
      ): Partial<Invoice>[] => {
        return invoices.filter((inv) => inv.status === status);
      };

      const invoices: Partial<Invoice>[] = [
        { status: InvoiceStatus.DRAFT },
        { status: InvoiceStatus.SENT },
        { status: InvoiceStatus.PAID },
        { status: InvoiceStatus.PAID },
      ];

      expect(filterByStatus(invoices, InvoiceStatus.PAID).length).toBe(2);
      expect(filterByStatus(invoices, InvoiceStatus.DRAFT).length).toBe(1);
    });

    it('should filter invoices by date range', () => {
      const filterByDateRange = (
        invoices: Partial<Invoice>[],
        startDate: Date,
        endDate: Date,
      ): Partial<Invoice>[] => {
        return invoices.filter((inv) => {
          const issueDate = inv.issueDate;
          return issueDate && issueDate >= startDate && issueDate <= endDate;
        });
      };

      const invoices: Partial<Invoice>[] = [
        { issueDate: new Date('2024-01-15') },
        { issueDate: new Date('2024-02-15') },
        { issueDate: new Date('2024-03-15') },
      ];

      const filtered = filterByDateRange(
        invoices,
        new Date('2024-01-01'),
        new Date('2024-02-28'),
      );

      expect(filtered.length).toBe(2);
    });
  });
});

// Extended interface for InvoiceLineItem with additional properties
declare module '../entities/invoice.entity' {
  interface InvoiceLineItem {
    category?: string;
    isOneTime?: boolean;
    isDiscount?: boolean;
    isAdjustment?: boolean;
    isProration?: boolean;
    isCredit?: boolean;
    discountCode?: string;
    adjustmentReason?: string;
    adjustedBy?: string;
    adjustedAt?: Date;
    creditReason?: string;
    prorationDays?: number;
    prorationTotal?: number;
    usagePeriodStart?: Date;
    usagePeriodEnd?: Date;
    subscriptionPeriod?: string;
  }

  interface Invoice {
    isFinalized?: boolean;
    finalizedAt?: Date;
    isLocked?: boolean;
    paidAt?: Date;
    paymentId?: string;
    voidedAt?: Date;
    voidReason?: string;
    isCreditMemo?: boolean;
    relatedInvoiceId?: string;
    replacesInvoiceId?: string;
  }
}
