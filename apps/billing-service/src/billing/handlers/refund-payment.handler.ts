import { Injectable, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { OutboxPublisher } from '@platform/outbox';
import { createBaseEvent, PaymentRefundedEvent } from '@platform/event-contracts';
import { AuditedOperation } from '@aquaculture/backend-common/audit';
import { StripeApiService } from '@aquaculture/backend-common/billing';
import { Money } from '@aquaculture/backend-common/monetary';
import { maskAndTruncatePii } from '@aquaculture/backend-common/utils';
import Decimal from 'decimal.js';
import { RefundPaymentCommand } from '../commands/refund-payment.command';
import { Payment, PaymentStatus, RefundInfo } from '../entities/payment.entity';
import { Invoice, InvoiceStatus } from '../entities/invoice.entity';

@AuditedOperation({ resource: 'Payment', action: 'REFUND' })
@Injectable()
@CommandHandler(RefundPaymentCommand)
export class RefundPaymentHandler implements ICommandHandler<RefundPaymentCommand, Payment> {
  private readonly logger = new Logger(RefundPaymentHandler.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly outboxPublisher: OutboxPublisher,
    private readonly stripeApi: StripeApiService,
  ) {}

  async execute(command: RefundPaymentCommand): Promise<Payment> {
    const { tenantId, input, userId } = command;

    return await this.dataSource.transaction(async (manager) => {
      // Fetch payment with pessimistic lock to prevent race conditions (double refund)
      const payment = await manager.findOne(Payment, {
        where: { id: input.paymentId, tenantId },
        lock: { mode: 'pessimistic_write' },
      });

      if (!payment) {
        throw new NotFoundException(`Payment with id ${input.paymentId} not found`);
      }

      // Only succeeded, or already partially refunded payments can be refunded
      const refundableStatuses = [PaymentStatus.SUCCEEDED, PaymentStatus.PARTIALLY_REFUNDED];
      if (!refundableStatuses.includes(payment.status)) {
        throw new BadRequestException(
          `Cannot refund payment with status ${payment.status}. Only succeeded or partially refunded payments can be refunded.`,
        );
      }

      // Validate refund amount
      if (input.amount <= 0) {
        throw new BadRequestException('Refund amount must be greater than zero');
      }

      const currentRefundedMoney = Money.of(payment.refundedAmount, payment.currency);
      const originalAmountMoney = Money.of(payment.amount, payment.currency);
      const maxRefundableMoney = originalAmountMoney.subtract(currentRefundedMoney);
      const refundMoney = Money.of(input.amount, payment.currency);

      // Double refund guard: refundedAmount + newRefund must not exceed originalAmount
      if (refundMoney.greaterThan(maxRefundableMoney)) {
        throw new BadRequestException(
          `Refund amount ${refundMoney} exceeds maximum refundable amount ${maxRefundableMoney}. ` +
          `Original payment: ${originalAmountMoney}, already refunded: ${currentRefundedMoney}.`,
        );
      }

      // W1.1 (SSOT-C-12): issue the REAL Stripe refund — but ONLY after the
      // double-refund guard above passes, and under the same pessimistic lock, so
      // money never moves on an invalid request and concurrent refunds can't
      // race past the cap. Refunds are rare/admin-initiated (not bursty), so
      // holding the connection across this one call is acceptable. The
      // idempotency key folds in the prior refunded total, so a retry of THIS
      // refund reuses the Stripe refund while a later distinct partial refund
      // gets a fresh one. Payments with no Stripe charge (legacy/manual) keep the
      // caller-supplied refundId.
      let stripeRefundId = input.refundId;
      if (payment.stripeChargeId) {
        const stripeRefund = await this.stripeApi.createRefund({
          tenantId,
          chargeId: payment.stripeChargeId,
          amount: refundMoney.toMinorUnitsBigInt(),
          reason: 'requested_by_customer',
          idempotencyKey: `refund:${payment.id}:${currentRefundedMoney.toMinorUnitsBigInt()}:${refundMoney.toMinorUnitsBigInt()}`,
        });
        stripeRefundId = stripeRefund.id;
      }

      // BILLING-MEDIUM-003 cure: refund reason comes from caller-
      // supplied input (admin operator or API consumer). Without
      // mask + truncation a malicious or careless input can:
      //   - Leak PII into operational storage (operator types
      //     "Refunded card 4242 for jane@x.com" — the failureReason
      //     column then carries email + last-4 indefinitely).
      //   - Inflate column size via long pasted blob (theoretically
      //     unbounded on a `text` column).
      // Same canonical helper as stripe-webhook.service.ts above —
      // single SSoT for failure-reason-style fields across the
      // billing service.
      const sanitizedReason = maskAndTruncatePii(input.reason, 500);

      // Build RefundInfo entry
      const refundInfo: RefundInfo = {
        amount: input.amount,
        reason: sanitizedReason ?? '',
        refundedAt: new Date(),
        refundId: stripeRefundId,
      };

      // Push to refunds array
      if (!payment.refunds) {
        payment.refunds = [];
      }
      payment.refunds.push(refundInfo);

      // Update refundedAmount with Money-based precision arithmetic
      const newRefundedMoney = currentRefundedMoney.add(refundMoney);
      payment.refundedAmount = newRefundedMoney.toDecimal();

      // Determine if full or partial refund
      const remainingMoney = originalAmountMoney.subtract(newRefundedMoney);
      const isFullRefund = remainingMoney.isZero() || remainingMoney.isNegative();

      if (isFullRefund) {
        payment.status = PaymentStatus.REFUNDED;
        payment.refundedAmount = originalAmountMoney.toDecimal(); // Normalize to prevent tiny remainder
      } else {
        payment.status = PaymentStatus.PARTIALLY_REFUNDED;
      }

      payment.updatedBy = userId;
      const savedPayment = await manager.save(Payment, payment);

      // Update invoice: increase amountDue by refund amount, decrease amountPaid
      const invoice = await manager.findOne(Invoice, {
        where: { id: payment.invoiceId, tenantId },
        lock: { mode: 'pessimistic_write' },
      });

      if (invoice) {
        const invoicePaidMoney = Money.of(invoice.amountPaid, invoice.currency);
        const newInvoicePaidMoney = invoicePaidMoney.subtract(refundMoney);
        const invoiceTotalMoney = Money.of(invoice.total, invoice.currency);

        // Prevent negative paid amount
        const clampedPaidMoney = newInvoicePaidMoney.isNegative()
          ? Money.zero(invoice.currency)
          : newInvoicePaidMoney;
        const newInvoiceDueMoney = invoiceTotalMoney.subtract(clampedPaidMoney);

        invoice.amountPaid = clampedPaidMoney.toDecimal();
        invoice.amountDue = newInvoiceDueMoney.isNegative()
          ? new Decimal(0)
          : newInvoiceDueMoney.toDecimal();

        // Update invoice status based on remaining paid amount
        if (clampedPaidMoney.isZero()) {
          // Fully refunded - no money left
          invoice.status = InvoiceStatus.REFUNDED;
          invoice.amountPaid = new Decimal(0);
          invoice.paidAt = undefined;
        } else if (newInvoiceDueMoney.isPositive()) {
          // Partially paid after refund
          invoice.status = InvoiceStatus.PARTIALLY_PAID;
        }
        // If still fully paid (partial refund on overpaid invoice), keep PAID status

        invoice.updatedBy = userId;
        await manager.save(Invoice, invoice);

        this.logger.log(
          `Invoice ${invoice.id} updated after refund: amountPaid=${invoice.amountPaid}, amountDue=${invoice.amountDue}, status=${invoice.status}`,
        );
      }

      this.logger.log(
        `Payment refunded: ${savedPayment.id}, amount=${input.amount}, totalRefunded=${savedPayment.refundedAmount}, ` +
        `status=${savedPayment.status}, reason="${sanitizedReason ?? ''}"`,
      );

      // Enqueue PaymentRefunded into the transactional outbox so the event
      // commits atomically with the payment + invoice writes. A relay publishes
      // to NATS after commit; an enqueue failure rolls the refund back rather
      // than committing a financial change without its event (replaces the prior
      // fire-and-forget eventBus.publish swallowing try/catch).
      const event: PaymentRefundedEvent = {
        ...createBaseEvent<PaymentRefundedEvent>('PaymentRefunded', tenantId, { userId }),
        paymentId: savedPayment.id,
        invoiceId: payment.invoiceId,
        refundAmount: input.amount,
        totalRefunded: savedPayment.refundedAmount.toNumber(),
        currency: payment.currency,
        reason: sanitizedReason ?? '',
        refundId: stripeRefundId,
        isFullRefund,
        refundedAt: refundInfo.refundedAt,
      };
      await this.outboxPublisher.enqueue(event, manager);

      return savedPayment;
    });
  }
}
