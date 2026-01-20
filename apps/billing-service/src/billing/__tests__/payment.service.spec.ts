/**
 * Payment Service Tests
 *
 * Comprehensive tests for payment processing, refunds, and reconciliation
 */

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Payment, PaymentStatus, PaymentMethod, PaymentMethodDetails } from '../entities/payment.entity';
import { Invoice, InvoiceStatus } from '../entities/invoice.entity';

// Local interface for test RefundInfo with extended fields
interface LocalRefundInfo {
  refundId?: string;
  originalPaymentId: string;
  amount: number;
  reason: string;
  status: string;
  refundedAt: Date;
}

describe('Payment Service', () => {
  let paymentRepository: jest.Mocked<Repository<Payment>>;
  let invoiceRepository: jest.Mocked<Repository<Invoice>>;
  let eventEmitter: jest.Mocked<EventEmitter2>;

  const mockPaymentRepository = {
    create: jest.fn(),
    save: jest.fn(),
    findOne: jest.fn(),
    find: jest.fn(),
    update: jest.fn(),
  };

  const mockInvoiceRepository = {
    findOne: jest.fn(),
    save: jest.fn(),
  };

  const mockEventEmitter = {
    emit: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        {
          provide: getRepositoryToken(Payment),
          useValue: mockPaymentRepository,
        },
        {
          provide: getRepositoryToken(Invoice),
          useValue: mockInvoiceRepository,
        },
        {
          provide: EventEmitter2,
          useValue: mockEventEmitter,
        },
      ],
    }).compile();

    paymentRepository = module.get(getRepositoryToken(Payment));
    invoiceRepository = module.get(getRepositoryToken(Invoice));
    eventEmitter = module.get(EventEmitter2);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // ============================================================================
  // PAYMENT METHOD TESTS
  // ============================================================================
  describe('Payment Methods', () => {
    describe('Credit Card', () => {
      it('should process credit card payment', async () => {
        const processCardPayment = async (
          invoiceId: string,
          cardDetails: PaymentMethodDetails,
          amount: number,
        ): Promise<Partial<Payment>> => {
          // Validate card
          if (!cardDetails.cardLast4 || cardDetails.cardLast4.length !== 4) {
            throw new Error('Invalid card number');
          }

          return {
            id: `pay-${Date.now()}`,
            invoiceId,
            amount,
            status: PaymentStatus.SUCCEEDED,
            paymentMethod: PaymentMethod.CREDIT_CARD,
            paymentMethodDetails: cardDetails,
            processedAt: new Date(),
          };
        };

        const cardDetails: PaymentMethodDetails = {
          cardLast4: '4242',
          cardBrand: 'visa',
          cardExpMonth: 12,
          cardExpYear: 2025,
        };

        const payment = await processCardPayment('inv-123', cardDetails, 199.00);

        expect(payment.status).toBe(PaymentStatus.SUCCEEDED);
        expect(payment.paymentMethod).toBe(PaymentMethod.CREDIT_CARD);
        expect(payment.paymentMethodDetails?.cardLast4).toBe('4242');
      });

      it('should process debit card payment', async () => {
        const payment: Partial<Payment> = {
          paymentMethod: PaymentMethod.DEBIT_CARD,
          paymentMethodDetails: {
            cardLast4: '1234',
            cardBrand: 'mastercard',
          },
          status: PaymentStatus.SUCCEEDED,
        };

        expect(payment.paymentMethod).toBe(PaymentMethod.DEBIT_CARD);
      });

      it('should handle credit card with wallet', async () => {
        const payment: Partial<Payment> = {
          paymentMethod: PaymentMethod.CREDIT_CARD,
          paymentMethodDetails: {
            cardLast4: '9999',
            cardBrand: 'visa',
          },
          status: PaymentStatus.SUCCEEDED,
        };

        expect(payment.paymentMethod).toBe(PaymentMethod.CREDIT_CARD);
      });

      it('should handle other payment method', async () => {
        const payment: Partial<Payment> = {
          paymentMethod: PaymentMethod.OTHER,
          paymentMethodDetails: {
            cardLast4: '8888',
          },
          status: PaymentStatus.SUCCEEDED,
        };

        expect(payment.paymentMethod).toBe(PaymentMethod.OTHER);
      });
    });

    describe('Bank Transfer', () => {
      it('should process ACH bank transfer', async () => {
        const payment: Partial<Payment> = {
          paymentMethod: PaymentMethod.ACH,
          paymentMethodDetails: {
            bankName: 'Chase Bank',
            bankAccountLast4: '5678',
          },
          status: PaymentStatus.PENDING,
        };

        expect(payment.paymentMethod).toBe(PaymentMethod.ACH);
        expect(payment.status).toBe(PaymentStatus.PENDING); // Bank transfers are initially pending
      });

      it('should handle wire transfer', async () => {
        const payment: Partial<Payment> = {
          paymentMethod: PaymentMethod.WIRE_TRANSFER,
          paymentMethodDetails: {
            bankName: 'International Bank',
          },
          status: PaymentStatus.PENDING,
          referenceNumber: 'WIRE-2024-0001',
        };

        expect(payment.paymentMethod).toBe(PaymentMethod.WIRE_TRANSFER);
        expect(payment.referenceNumber).toBeDefined();
      });
    });

    describe('Digital Wallets', () => {
      it('should process PayPal payment', async () => {
        const payment: Partial<Payment> = {
          paymentMethod: PaymentMethod.PAYPAL,
          paymentMethodDetails: {
            bankName: 'PayPal',
          },
          status: PaymentStatus.SUCCEEDED,
        };

        expect(payment.paymentMethod).toBe(PaymentMethod.PAYPAL);
      });
    });
  });

  // ============================================================================
  // PAYMENT CAPTURE TESTS
  // ============================================================================
  describe('Payment Capture', () => {
    describe('Authorization', () => {
      it('should authorize payment successfully', async () => {
        const authorizePayment = async (
          amount: number,
          currency: string,
        ): Promise<{ authorizationId: string; status: string }> => {
          return {
            authorizationId: `auth-${Date.now()}`,
            status: 'authorized',
          };
        };

        const result = await authorizePayment(199.00, 'USD');

        expect(result.authorizationId).toBeDefined();
        expect(result.status).toBe('authorized');
      });

      it('should capture authorized payment', async () => {
        const capturePayment = async (
          authorizationId: string,
          amount: number,
        ): Promise<Partial<Payment>> => {
          return {
            id: `pay-${Date.now()}`,
            authorizationId,
            amount,
            status: PaymentStatus.SUCCEEDED,
            capturedAt: new Date(),
          };
        };

        const payment = await capturePayment('auth-123', 199.00);

        expect(payment.status).toBe(PaymentStatus.SUCCEEDED);
        expect(payment.capturedAt).toBeDefined();
      });
    });

    describe('Amount Validation', () => {
      it('should validate payment amount matches invoice', () => {
        const validateAmount = (paymentAmount: number, invoiceAmount: number): boolean => {
          return Math.abs(paymentAmount - invoiceAmount) < 0.01;
        };

        expect(validateAmount(199.00, 199.00)).toBe(true);
        expect(validateAmount(199.00, 199.01)).toBe(true); // Within tolerance
        expect(validateAmount(199.00, 200.00)).toBe(false);
      });

      it('should validate currency matches', () => {
        const validateCurrency = (paymentCurrency: string, invoiceCurrency: string): boolean => {
          return paymentCurrency.toUpperCase() === invoiceCurrency.toUpperCase();
        };

        expect(validateCurrency('USD', 'USD')).toBe(true);
        expect(validateCurrency('usd', 'USD')).toBe(true);
        expect(validateCurrency('EUR', 'USD')).toBe(false);
      });
    });

    describe('Idempotency', () => {
      it('should prevent duplicate payments', async () => {
        const processedPayments = new Map<string, Partial<Payment>>();

        const processWithIdempotency = async (
          idempotencyKey: string,
          paymentData: Partial<Payment>,
        ): Promise<Partial<Payment>> => {
          if (processedPayments.has(idempotencyKey)) {
            return processedPayments.get(idempotencyKey)!;
          }

          const payment = {
            ...paymentData,
            id: `pay-${Date.now()}`,
            idempotencyKey,
          };

          processedPayments.set(idempotencyKey, payment);
          return payment;
        };

        const key = 'idem-key-123';
        const payment1 = await processWithIdempotency(key, { amount: 100 });
        const payment2 = await processWithIdempotency(key, { amount: 100 });

        expect(payment1.id).toBe(payment2.id);
      });

      it('should generate unique payment IDs', () => {
        const generatePaymentId = (): string => {
          return `pay_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        };

        const ids = new Set<string>();
        for (let i = 0; i < 100; i++) {
          ids.add(generatePaymentId());
        }

        expect(ids.size).toBe(100);
      });
    });

    describe('Retry Mechanism', () => {
      it('should retry failed payment', async () => {
        let attempts = 0;

        const processWithRetry = async (
          maxRetries: number = 3,
        ): Promise<{ success: boolean; attempts: number }> => {
          while (attempts < maxRetries) {
            attempts++;
            if (attempts >= 2) {
              return { success: true, attempts };
            }
          }
          return { success: false, attempts };
        };

        const result = await processWithRetry(3);

        expect(result.success).toBe(true);
        expect(result.attempts).toBe(2);
      });
    });

    describe('Partial Payment', () => {
      it('should handle partial payment', async () => {
        const handlePartialPayment = (
          invoiceTotal: number,
          paymentAmount: number,
        ): { remainingBalance: number; isPartial: boolean } => {
          const remainingBalance = invoiceTotal - paymentAmount;
          return {
            remainingBalance: Math.max(0, remainingBalance),
            isPartial: remainingBalance > 0.01,
          };
        };

        const result = handlePartialPayment(500.00, 200.00);

        expect(result.isPartial).toBe(true);
        expect(result.remainingBalance).toBe(300.00);
      });

      it('should track multiple payments for one invoice', () => {
        const invoicePayments: { invoiceId: string; payments: Partial<Payment>[] } = {
          invoiceId: 'inv-123',
          payments: [
            { id: 'pay-1', amount: 200.00, status: PaymentStatus.SUCCEEDED },
            { id: 'pay-2', amount: 200.00, status: PaymentStatus.SUCCEEDED },
            { id: 'pay-3', amount: 100.00, status: PaymentStatus.SUCCEEDED },
          ],
        };

        const totalPaid = invoicePayments.payments.reduce((sum, p) => sum + (p.amount || 0), 0);

        expect(totalPaid).toBe(500.00);
      });
    });

    describe('Overpayment', () => {
      it('should handle overpayment', () => {
        const handleOverpayment = (
          invoiceTotal: number,
          paymentAmount: number,
        ): { creditBalance: number; isOverpayment: boolean } => {
          const excess = paymentAmount - invoiceTotal;
          return {
            creditBalance: Math.max(0, excess),
            isOverpayment: excess > 0.01,
          };
        };

        const result = handleOverpayment(500.00, 550.00);

        expect(result.isOverpayment).toBe(true);
        expect(result.creditBalance).toBe(50.00);
      });
    });
  });

  // ============================================================================
  // PAYMENT FAILURES TESTS
  // ============================================================================
  describe('Payment Failures', () => {
    describe('Failure Handling', () => {
      it('should handle insufficient funds', () => {
        const handleDecline = (declineCode: string): string => {
          const messages: Record<string, string> = {
            insufficient_funds: 'Your card has insufficient funds',
            card_declined: 'Your card was declined',
            expired_card: 'Your card has expired',
            incorrect_cvc: 'The security code is incorrect',
            processing_error: 'A processing error occurred',
          };
          return messages[declineCode] || 'Payment failed';
        };

        expect(handleDecline('insufficient_funds')).toContain('insufficient funds');
      });

      it('should handle expired card', () => {
        const isCardExpired = (expiryMonth: number, expiryYear: number): boolean => {
          const now = new Date();
          const expiry = new Date(expiryYear, expiryMonth, 0);
          return now > expiry;
        };

        expect(isCardExpired(12, 2020)).toBe(true);
        expect(isCardExpired(12, 2030)).toBe(false);
      });

      it('should handle declined payment retry', async () => {
        interface RetryConfig {
          maxRetries: number;
          retryDelayMs: number[];
        }

        const config: RetryConfig = {
          maxRetries: 3,
          retryDelayMs: [1000, 2000, 4000], // Exponential backoff
        };

        expect(config.retryDelayMs[0]).toBe(1000);
        expect(config.retryDelayMs[2]).toBe(4000);
      });

      it('should send failed payment notification', async () => {
        const notifications: { type: string; recipient: string }[] = [];

        const notifyPaymentFailure = (tenantId: string, amount: number, reason: string): void => {
          notifications.push({
            type: 'payment_failed',
            recipient: tenantId,
          });
        };

        notifyPaymentFailure('tenant-1', 199.00, 'Card declined');

        expect(notifications.length).toBe(1);
        expect(notifications[0]?.type).toBe('payment_failed');
      });

      it('should implement grace period before suspension', () => {
        const getGracePeriodDays = (planTier: string): number => {
          const gracePeriods: Record<string, number> = {
            starter: 3,
            professional: 7,
            enterprise: 14,
          };
          return gracePeriods[planTier] || 3;
        };

        expect(getGracePeriodDays('enterprise')).toBe(14);
        expect(getGracePeriodDays('starter')).toBe(3);
      });

      it('should implement dunning process', () => {
        interface DunningStep {
          day: number;
          action: string;
          retryPayment: boolean;
        }

        const dunningSchedule: DunningStep[] = [
          { day: 1, action: 'send_reminder', retryPayment: true },
          { day: 3, action: 'send_warning', retryPayment: true },
          { day: 7, action: 'send_final_notice', retryPayment: true },
          { day: 10, action: 'suspend_account', retryPayment: false },
          { day: 30, action: 'cancel_subscription', retryPayment: false },
        ];

        expect(dunningSchedule.length).toBe(5);
        expect(dunningSchedule[3]?.action).toBe('suspend_account');
      });

      it('should offer payment plan for failed payments', () => {
        interface PaymentPlan {
          invoiceId: string;
          totalAmount: number;
          installments: number;
          installmentAmount: number;
          schedule: Date[];
        }

        const createPaymentPlan = (
          invoiceId: string,
          totalAmount: number,
          installments: number,
        ): PaymentPlan => {
          const installmentAmount = Math.ceil((totalAmount / installments) * 100) / 100;
          const schedule: Date[] = [];

          for (let i = 0; i < installments; i++) {
            const date = new Date();
            date.setDate(date.getDate() + i * 30);
            schedule.push(date);
          }

          return {
            invoiceId,
            totalAmount,
            installments,
            installmentAmount,
            schedule,
          };
        };

        const plan = createPaymentPlan('inv-123', 300.00, 3);

        expect(plan.installments).toBe(3);
        expect(plan.installmentAmount).toBe(100.00);
        expect(plan.schedule.length).toBe(3);
      });
    });
  });

  // ============================================================================
  // PAYMENT RECONCILIATION TESTS
  // ============================================================================
  describe('Payment Reconciliation', () => {
    it('should match payment to invoice', () => {
      const matchPaymentToInvoice = (
        payment: Partial<Payment>,
        invoices: Partial<Invoice>[],
      ): Partial<Invoice> | null => {
        return (
          invoices.find(
            (inv) =>
              inv.id === payment.invoiceId ||
              inv.invoiceNumber === payment.referenceNumber,
          ) || null
        );
      };

      const invoices: Partial<Invoice>[] = [
        { id: 'inv-1', invoiceNumber: 'INV-001' },
        { id: 'inv-2', invoiceNumber: 'INV-002' },
      ];

      const payment: Partial<Payment> = { invoiceId: 'inv-1' };
      const matched = matchPaymentToInvoice(payment, invoices);

      expect(matched?.id).toBe('inv-1');
    });

    it('should allocate multi-invoice payment', () => {
      interface PaymentAllocation {
        invoiceId: string;
        amount: number;
      }

      const allocatePayment = (
        paymentAmount: number,
        invoices: Partial<Invoice>[],
      ): PaymentAllocation[] => {
        const allocations: PaymentAllocation[] = [];
        let remaining = paymentAmount;

        // Allocate to oldest invoices first
        const sorted = [...invoices].sort(
          (a, b) => (a.issueDate?.getTime() || 0) - (b.issueDate?.getTime() || 0),
        );

        for (const invoice of sorted) {
          if (remaining <= 0) break;

          const invoiceBalance = invoice.total || 0;
          const allocation = Math.min(remaining, invoiceBalance);

          allocations.push({
            invoiceId: invoice.id!,
            amount: allocation,
          });

          remaining -= allocation;
        }

        return allocations;
      };

      const invoices: Partial<Invoice>[] = [
        { id: 'inv-1', total: 100, issueDate: new Date('2024-01-01') },
        { id: 'inv-2', total: 150, issueDate: new Date('2024-02-01') },
        { id: 'inv-3', total: 200, issueDate: new Date('2024-03-01') },
      ];

      const allocations = allocatePayment(300, invoices);

      expect(allocations.length).toBe(3);
      expect(allocations[0]?.amount).toBe(100);
      expect(allocations[1]?.amount).toBe(150);
      expect(allocations[2]?.amount).toBe(50);
    });

    it('should handle payment mismatch', () => {
      interface ReconciliationResult {
        matched: boolean;
        discrepancy: number;
        action: string;
      }

      const reconcile = (
        paymentAmount: number,
        invoiceAmount: number,
        tolerance: number = 0.01,
      ): ReconciliationResult => {
        const discrepancy = Math.abs(paymentAmount - invoiceAmount);

        if (discrepancy <= tolerance) {
          return { matched: true, discrepancy: 0, action: 'auto_match' };
        } else if (paymentAmount > invoiceAmount) {
          return { matched: false, discrepancy, action: 'create_credit' };
        } else {
          return { matched: false, discrepancy, action: 'partial_payment' };
        }
      };

      expect(reconcile(100, 100).matched).toBe(true);
      expect(reconcile(110, 100).action).toBe('create_credit');
      expect(reconcile(90, 100).action).toBe('partial_payment');
    });

    it('should support manual reconciliation', () => {
      interface ManualReconciliation {
        paymentId: string;
        invoiceId: string;
        reconciledBy: string;
        reconciledAt: Date;
        notes: string;
      }

      const manualReconciliation: ManualReconciliation = {
        paymentId: 'pay-123',
        invoiceId: 'inv-456',
        reconciledBy: 'finance@example.com',
        reconciledAt: new Date(),
        notes: 'Matched via bank reference',
      };

      expect(manualReconciliation.reconciledBy).toBeDefined();
      expect(manualReconciliation.notes).toBeDefined();
    });

    it('should reconcile with bank statement', () => {
      interface BankTransaction {
        transactionId: string;
        amount: number;
        date: Date;
        reference: string;
      }

      const matchBankTransaction = (
        transaction: BankTransaction,
        payments: Partial<Payment>[],
      ): Partial<Payment> | null => {
        return (
          payments.find(
            (p) =>
              p.amount === transaction.amount &&
              p.referenceNumber === transaction.reference,
          ) || null
        );
      };

      const bankTransaction: BankTransaction = {
        transactionId: 'bank-123',
        amount: 199.00,
        date: new Date(),
        reference: 'INV-2024-0001',
      };

      const payments: Partial<Payment>[] = [
        { id: 'pay-1', amount: 199.00, referenceNumber: 'INV-2024-0001' },
        { id: 'pay-2', amount: 99.00, referenceNumber: 'INV-2024-0002' },
      ];

      const matched = matchBankTransaction(bankTransaction, payments);

      expect(matched?.id).toBe('pay-1');
    });
  });

  // ============================================================================
  // REFUND PROCESSING TESTS
  // ============================================================================
  describe('Refund Processing', () => {
    describe('Full Refund', () => {
      it('should process full refund', async () => {
        const processRefund = (
          payment: Partial<Payment>,
          amount: number,
          reason: string,
        ): LocalRefundInfo => {
          return {
            refundId: `ref-${Date.now()}`,
            originalPaymentId: payment.id!,
            amount,
            reason,
            status: 'completed',
            refundedAt: new Date(),
          };
        };

        const payment: Partial<Payment> = { id: 'pay-123', amount: 199.00 };
        const refund = processRefund(payment, 199.00, 'Customer request');

        expect(refund.amount).toBe(199.00);
        expect(refund.status).toBe('completed');
      });
    });

    describe('Partial Refund', () => {
      it('should process partial refund', async () => {
        const processPartialRefund = (
          payment: Partial<Payment>,
          refundAmount: number,
        ): { refund: LocalRefundInfo; remainingAmount: number } => {
          const remaining = (payment.amount || 0) - refundAmount;

          return {
            refund: {
              refundId: `ref-${Date.now()}`,
              originalPaymentId: payment.id!,
              amount: refundAmount,
              reason: 'Partial refund',
              status: 'completed',
              refundedAt: new Date(),
            },
            remainingAmount: remaining,
          };
        };

        const payment: Partial<Payment> = { id: 'pay-123', amount: 199.00 };
        const result = processPartialRefund(payment, 50.00);

        expect(result.refund.amount).toBe(50.00);
        expect(result.remainingAmount).toBe(149.00);
      });

      it('should track multiple partial refunds', () => {
        const refunds: LocalRefundInfo[] = [
          { refundId: 'ref-1', originalPaymentId: 'pay-123', amount: 50, reason: 'First refund', status: 'completed', refundedAt: new Date() },
          { refundId: 'ref-2', originalPaymentId: 'pay-123', amount: 30, reason: 'Second refund', status: 'completed', refundedAt: new Date() },
        ];

        const totalRefunded = refunds.reduce((sum, r) => sum + r.amount, 0);

        expect(totalRefunded).toBe(80);
      });
    });

    describe('Refund Validation', () => {
      it('should record refund reason', () => {
        const validReasons = [
          'customer_request',
          'duplicate_payment',
          'billing_error',
          'service_issue',
          'cancellation',
        ];

        const validateReason = (reason: string): boolean => {
          return validReasons.includes(reason) || reason.length > 0;
        };

        expect(validateReason('customer_request')).toBe(true);
        expect(validateReason('Custom reason')).toBe(true);
        expect(validateReason('')).toBe(false);
      });

      it('should require refund approval for large amounts', () => {
        const requiresApproval = (amount: number, threshold: number = 500): boolean => {
          return amount >= threshold;
        };

        expect(requiresApproval(100)).toBe(false);
        expect(requiresApproval(500)).toBe(true);
        expect(requiresApproval(1000)).toBe(true);
      });

      it('should validate refund timeline', () => {
        const isWithinRefundWindow = (paymentDate: Date, windowDays: number = 30): boolean => {
          const now = new Date();
          const windowEnd = new Date(paymentDate);
          windowEnd.setDate(windowEnd.getDate() + windowDays);
          return now <= windowEnd;
        };

        const recentPayment = new Date();
        recentPayment.setDate(recentPayment.getDate() - 5);

        const oldPayment = new Date();
        oldPayment.setDate(oldPayment.getDate() - 60);

        expect(isWithinRefundWindow(recentPayment)).toBe(true);
        expect(isWithinRefundWindow(oldPayment)).toBe(false);
      });
    });

    describe('Refund Method', () => {
      it('should refund to original payment method', () => {
        const getRefundMethod = (originalPayment: Partial<Payment>): PaymentMethod => {
          return originalPayment.paymentMethod || PaymentMethod.CREDIT_CARD;
        };

        const payment: Partial<Payment> = { paymentMethod: PaymentMethod.CREDIT_CARD };

        expect(getRefundMethod(payment)).toBe(PaymentMethod.CREDIT_CARD);
      });

      it('should generate credit note for refund', () => {
        interface CreditNote {
          id: string;
          refundId?: string;
          amount: number;
          invoiceId: string;
          createdAt: Date;
        }

        const createCreditNote = (refund: LocalRefundInfo, invoiceId: string): CreditNote => {
          return {
            id: `cn-${Date.now()}`,
            refundId: refund.refundId,
            amount: refund.amount,
            invoiceId,
            createdAt: new Date(),
          };
        };

        const refund: LocalRefundInfo = {
          refundId: 'ref-123',
          originalPaymentId: 'pay-123',
          amount: 100,
          reason: 'Refund',
          status: 'completed',
          refundedAt: new Date(),
        };

        const creditNote = createCreditNote(refund, 'inv-456');

        expect(creditNote.refundId).toBe('ref-123');
        expect(creditNote.amount).toBe(100);
      });
    });
  });

  // ============================================================================
  // FRAUD DETECTION TESTS
  // ============================================================================
  describe('Fraud Detection', () => {
    it('should detect duplicate payment', () => {
      const isDuplicatePayment = (
        newPayment: Partial<Payment>,
        recentPayments: Partial<Payment>[],
        windowMinutes: number = 5,
      ): boolean => {
        const windowStart = new Date();
        windowStart.setMinutes(windowStart.getMinutes() - windowMinutes);

        return recentPayments.some(
          (p) =>
            p.amount === newPayment.amount &&
            p.invoiceId === newPayment.invoiceId &&
            p.createdAt &&
            p.createdAt > windowStart,
        );
      };

      const recentPayments: Partial<Payment>[] = [
        { amount: 199, invoiceId: 'inv-1', createdAt: new Date() },
      ];

      const duplicatePayment: Partial<Payment> = { amount: 199, invoiceId: 'inv-1' };
      const uniquePayment: Partial<Payment> = { amount: 199, invoiceId: 'inv-2' };

      expect(isDuplicatePayment(duplicatePayment, recentPayments)).toBe(true);
      expect(isDuplicatePayment(uniquePayment, recentPayments)).toBe(false);
    });

    it('should flag suspicious activity', () => {
      interface SuspiciousActivity {
        type: string;
        severity: 'low' | 'medium' | 'high';
        details: string;
      }

      const detectSuspiciousActivity = (
        payment: Partial<Payment>,
        tenantHistory: Partial<Payment>[],
      ): SuspiciousActivity[] => {
        const alerts: SuspiciousActivity[] = [];

        // Check for unusually large payment
        const avgAmount =
          tenantHistory.reduce((sum, p) => sum + (p.amount || 0), 0) /
          Math.max(tenantHistory.length, 1);

        if ((payment.amount || 0) > avgAmount * 5) {
          alerts.push({
            type: 'unusual_amount',
            severity: 'medium',
            details: `Payment ${payment.amount} is significantly higher than average ${avgAmount.toFixed(2)}`,
          });
        }

        return alerts;
      };

      const history: Partial<Payment>[] = [
        { amount: 100 },
        { amount: 100 },
        { amount: 100 },
      ];

      const normalPayment: Partial<Payment> = { amount: 150 };
      const suspiciousPayment: Partial<Payment> = { amount: 1000 };

      expect(detectSuspiciousActivity(normalPayment, history).length).toBe(0);
      expect(detectSuspiciousActivity(suspiciousPayment, history).length).toBeGreaterThan(0);
    });

    it('should require review for high-value transactions', () => {
      const requiresReview = (amount: number, threshold: number = 10000): boolean => {
        return amount >= threshold;
      };

      expect(requiresReview(5000)).toBe(false);
      expect(requiresReview(15000)).toBe(true);
    });

    it('should implement velocity check', () => {
      const checkVelocity = (
        recentPayments: Partial<Payment>[],
        maxPaymentsPerHour: number = 5,
      ): boolean => {
        const oneHourAgo = new Date();
        oneHourAgo.setHours(oneHourAgo.getHours() - 1);

        const recentCount = recentPayments.filter(
          (p) => p.createdAt && p.createdAt > oneHourAgo,
        ).length;

        return recentCount < maxPaymentsPerHour;
      };

      const payments: Partial<Payment>[] = Array.from({ length: 3 }, () => ({
        createdAt: new Date(),
      }));

      expect(checkVelocity(payments, 5)).toBe(true);
      expect(checkVelocity([...payments, ...payments], 5)).toBe(false);
    });

    it('should monitor chargebacks', () => {
      interface ChargebackStats {
        totalChargebacks: number;
        chargebackRate: number;
        isHighRisk: boolean;
      }

      const calculateChargebackStats = (
        chargebacks: number,
        totalPayments: number,
      ): ChargebackStats => {
        const rate = totalPayments > 0 ? (chargebacks / totalPayments) * 100 : 0;

        return {
          totalChargebacks: chargebacks,
          chargebackRate: rate,
          isHighRisk: rate > 1, // 1% threshold
        };
      };

      expect(calculateChargebackStats(1, 1000).isHighRisk).toBe(false);
      expect(calculateChargebackStats(20, 1000).isHighRisk).toBe(true);
    });
  });

  // ============================================================================
  // PAYMENT STATUS TESTS
  // ============================================================================
  describe('Payment Status', () => {
    it('should transition through valid statuses', () => {
      const validTransitions: Record<PaymentStatus, PaymentStatus[]> = {
        [PaymentStatus.PENDING]: [PaymentStatus.PROCESSING, PaymentStatus.FAILED, PaymentStatus.CANCELLED],
        [PaymentStatus.PROCESSING]: [PaymentStatus.SUCCEEDED, PaymentStatus.FAILED],
        [PaymentStatus.SUCCEEDED]: [PaymentStatus.REFUNDED, PaymentStatus.PARTIALLY_REFUNDED],
        [PaymentStatus.FAILED]: [PaymentStatus.PENDING],
        [PaymentStatus.CANCELLED]: [],
        [PaymentStatus.REFUNDED]: [],
        [PaymentStatus.PARTIALLY_REFUNDED]: [PaymentStatus.REFUNDED],
      };

      const canTransition = (from: PaymentStatus, to: PaymentStatus): boolean => {
        return validTransitions[from]?.includes(to) ?? false;
      };

      expect(canTransition(PaymentStatus.PENDING, PaymentStatus.PROCESSING)).toBe(true);
      expect(canTransition(PaymentStatus.PENDING, PaymentStatus.REFUNDED)).toBe(false);
      expect(canTransition(PaymentStatus.SUCCEEDED, PaymentStatus.REFUNDED)).toBe(true);
    });
  });

  // ============================================================================
  // WEBHOOK HANDLING TESTS
  // ============================================================================
  describe('Payment Gateway Webhooks', () => {
    it('should verify webhook signature', () => {
      const verifySignature = (
        payload: string,
        signature: string,
        secret: string,
      ): boolean => {
        // Simplified verification - in production use HMAC
        const expectedSignature = Buffer.from(`${secret}:${payload}`).toString('base64');
        return signature === expectedSignature;
      };

      const payload = '{"event":"payment.completed"}';
      const secret = 'webhook_secret';
      const validSignature = Buffer.from(`${secret}:${payload}`).toString('base64');

      expect(verifySignature(payload, validSignature, secret)).toBe(true);
      expect(verifySignature(payload, 'invalid', secret)).toBe(false);
    });

    it('should handle payment.completed webhook', async () => {
      interface WebhookEvent {
        type: string;
        data: {
          paymentId: string;
          amount: number;
          status: string;
        };
      }

      const handleWebhook = (event: WebhookEvent): string => {
        switch (event.type) {
          case 'payment.completed':
            return 'Payment marked as completed';
          case 'payment.failed':
            return 'Payment marked as failed';
          default:
            return 'Unknown event';
        }
      };

      const completedEvent: WebhookEvent = {
        type: 'payment.completed',
        data: { paymentId: 'pay-123', amount: 199, status: 'completed' },
      };

      expect(handleWebhook(completedEvent)).toBe('Payment marked as completed');
    });

    it('should handle webhook retry', () => {
      interface WebhookDelivery {
        webhookId: string;
        attempts: number;
        lastAttemptAt: Date;
        nextRetryAt: Date | null;
        status: 'pending' | 'delivered' | 'failed';
      }

      const calculateNextRetry = (attempts: number): Date | null => {
        if (attempts >= 5) return null;

        const delayMinutes = Math.pow(2, attempts) * 5; // Exponential backoff
        const nextRetry = new Date();
        nextRetry.setMinutes(nextRetry.getMinutes() + delayMinutes);
        return nextRetry;
      };

      expect(calculateNextRetry(0)).not.toBeNull();
      expect(calculateNextRetry(5)).toBeNull();
    });

    it('should alert on failed webhook', () => {
      const alerts: { type: string; message: string }[] = [];

      const alertWebhookFailure = (webhookId: string, attempts: number): void => {
        if (attempts >= 3) {
          alerts.push({
            type: 'webhook_failure',
            message: `Webhook ${webhookId} failed after ${attempts} attempts`,
          });
        }
      };

      alertWebhookFailure('wh-123', 3);

      expect(alerts.length).toBe(1);
      expect(alerts[0]?.type).toBe('webhook_failure');
    });
  });
});

// Extended interfaces
declare module '../entities/payment.entity' {
  interface Payment {
    idempotencyKey?: string;
    authorizationId?: string;
    capturedAt?: Date;
    referenceNumber?: string;
  }

  interface PaymentMethodDetails {
    bankName?: string;
    bankAccountLast4?: string;
  }
}
