import { Injectable, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { OutboxPublisher } from '@platform/outbox';
import { createBaseEvent, PaymentReceivedEvent } from '@platform/event-contracts';
import { AuditedOperation } from '@aquaculture/backend-common/audit';
import { Money } from '@aquaculture/backend-common/monetary';
import Decimal from 'decimal.js';
import { RecordPaymentCommand } from '../commands/record-payment.command';
import { Payment, PaymentStatus } from '../entities/payment.entity';
import { Invoice, InvoiceStatus } from '../entities/invoice.entity';
import { randomUUID } from 'crypto';

@AuditedOperation({ resource: 'Payment', action: 'CREATE' })
@Injectable()
@CommandHandler(RecordPaymentCommand)
export class RecordPaymentHandler implements ICommandHandler<RecordPaymentCommand, Payment> {
  private readonly logger = new Logger(RecordPaymentHandler.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly outboxPublisher: OutboxPublisher,
  ) {}

  async execute(command: RecordPaymentCommand): Promise<Payment> {
    const { tenantId, input, userId } = command;

    // Use transaction with pessimistic lock to prevent race conditions
    return await this.dataSource.transaction(async (manager) => {
      // Idempotency: if a stripePaymentIntentId is provided, check for an existing payment
      if (input.stripePaymentIntentId) {
        const existing = await manager.findOne(Payment, {
          where: { stripePaymentIntentId: input.stripePaymentIntentId },
        });
        if (existing) {
          this.logger.log(
            `Idempotent skip: payment with stripePaymentIntentId ${input.stripePaymentIntentId} already recorded as ${existing.id}`,
          );
          return existing;
        }
      }

      // Fetch invoice with pessimistic lock to prevent concurrent modifications
      const invoice = await manager.findOne(Invoice, {
        where: { id: input.invoiceId, tenantId },
        lock: { mode: 'pessimistic_write' },
      });

      if (!invoice) {
        throw new NotFoundException(`Invoice with id ${input.invoiceId} not found`);
      }

      // Check if invoice can accept payments
      const payableStatuses = [
        InvoiceStatus.PENDING,
        InvoiceStatus.SENT,
        InvoiceStatus.PARTIALLY_PAID,
        InvoiceStatus.OVERDUE,
      ];

      if (!payableStatuses.includes(invoice.status)) {
        throw new BadRequestException(
          `Cannot record payment for invoice with status ${invoice.status}`,
        );
      }

      // Validate payment currency matches invoice currency
      const paymentCurrency = input.currency || invoice.currency;
      if (paymentCurrency !== invoice.currency) {
        throw new BadRequestException(
          `Payment currency ${paymentCurrency} does not match invoice currency ${invoice.currency}`,
        );
      }

      // Validate payment amount against amount due using Money for precision
      const amountDueMoney = Money.of(invoice.amountDue, invoice.currency);
      const paymentMoney = Money.of(input.amount, paymentCurrency);

      if (paymentMoney.greaterThan(amountDueMoney)) {
        throw new BadRequestException(
          `Payment amount ${paymentMoney} exceeds amount due ${amountDueMoney}`,
        );
      }

      // Generate transaction ID
      const transactionId = `TXN-${Date.now()}-${randomUUID().substring(0, 8).toUpperCase()}`;

      const payment = manager.create(Payment, {
        tenantId,
        transactionId,
        invoiceId: input.invoiceId,
        amount: paymentMoney.toDecimal(),
        currency: input.currency || invoice.currency,
        status: PaymentStatus.SUCCEEDED,
        paymentMethod: input.paymentMethod,
        paymentMethodDetails: input.paymentMethodDetails,
        paymentDate: input.paymentDate ? new Date(input.paymentDate) : new Date(),
        processedAt: new Date(),
        stripePaymentIntentId: input.stripePaymentIntentId,
        stripeChargeId: input.stripeChargeId,
        notes: input.notes,
        refundedAmount: new Decimal(0),
        createdBy: userId,
        updatedBy: userId,
      });

      const savedPayment = await manager.save(Payment, payment);

      // Update invoice with Money-based precision arithmetic
      const currentPaidMoney = Money.of(invoice.amountPaid, invoice.currency);
      const newAmountPaidMoney = currentPaidMoney.add(paymentMoney);
      const totalMoney = Money.of(invoice.total, invoice.currency);
      const newAmountDueMoney = totalMoney.subtract(newAmountPaidMoney);

      invoice.amountPaid = newAmountPaidMoney.toDecimal();
      // Prevent negative due amount
      invoice.amountDue = newAmountDueMoney.isNegative()
        ? new Decimal(0)
        : newAmountDueMoney.toDecimal();

      if (newAmountDueMoney.isZero() || newAmountDueMoney.isNegative()) {
        invoice.status = InvoiceStatus.PAID;
        invoice.paidAt = new Date();
        invoice.amountDue = new Decimal(0);
      } else {
        invoice.status = InvoiceStatus.PARTIALLY_PAID;
      }

      invoice.updatedBy = userId;
      await manager.save(Invoice, invoice);

      this.logger.log(
        `Payment recorded: ${savedPayment.id} (${savedPayment.transactionId}) for invoice ${input.invoiceId}. Amount: ${input.amount}`,
      );

      // Enqueue PaymentReceived into the transactional outbox so the event is
      // atomic with the payment + invoice writes. The outbox relay publishes to
      // NATS after commit; a crash or broker outage can no longer lose a
      // financial event (replaces the prior fire-and-forget eventBus.publish).
      const event: PaymentReceivedEvent = {
        ...createBaseEvent<PaymentReceivedEvent>('PaymentReceived', tenantId, { userId }),
        paymentId: savedPayment.id,
        invoiceId: input.invoiceId,
        amount: savedPayment.amount.toNumber(),
        currency: savedPayment.currency,
        paymentMethod: savedPayment.paymentMethod,
        transactionId: savedPayment.transactionId,
        paidAt: savedPayment.paymentDate,
      };
      await this.outboxPublisher.enqueue(event, manager);

      return savedPayment;
    });
  }
}
