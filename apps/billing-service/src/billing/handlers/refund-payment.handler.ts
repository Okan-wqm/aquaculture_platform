import { Injectable, NotFoundException, BadRequestException, Logger, Optional, Inject } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { NatsEventBus } from '@platform/event-bus';
import { createBaseEvent, PaymentRefundedEvent } from '@platform/event-contracts';
import { AuditedOperation } from '@aquaculture/backend-common/audit';
import { Money } from '@aquaculture/backend-common/monetary';
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
    @Optional() @Inject('EVENT_BUS') private readonly eventBus?: NatsEventBus,
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

      // Build RefundInfo entry
      const refundInfo: RefundInfo = {
        amount: input.amount,
        reason: input.reason,
        refundedAt: new Date(),
        refundId: input.refundId,
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
        `status=${savedPayment.status}, reason="${input.reason}"`,
      );

      // Publish NATS event
      try {
        const event: PaymentRefundedEvent = {
          ...createBaseEvent<PaymentRefundedEvent>('PaymentRefunded', tenantId, { userId }),
          paymentId: savedPayment.id,
          invoiceId: payment.invoiceId,
          refundAmount: input.amount,
          totalRefunded: savedPayment.refundedAmount.toNumber(),
          currency: payment.currency,
          reason: input.reason,
          refundId: input.refundId,
          isFullRefund,
          refundedAt: refundInfo.refundedAt,
        };
        await this.eventBus?.publish(event);
      } catch (eventError) {
        // Event publish failure must not block the main operation
        this.logger.warn(
          `Failed to publish PaymentRefunded event for ${savedPayment.id}: ${
            eventError instanceof Error ? eventError.message : 'Unknown error'
          }`,
        );
      }

      return savedPayment;
    });
  }
}
