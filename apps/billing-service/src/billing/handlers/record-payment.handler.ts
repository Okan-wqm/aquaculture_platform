import { Injectable, NotFoundException, BadRequestException, Logger, Optional, Inject } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { NatsEventBus } from '@platform/event-bus';
import { createBaseEvent, PaymentReceivedEvent } from '@platform/event-contracts';
import { RecordPaymentCommand } from '../commands/record-payment.command';
import { Payment, PaymentStatus } from '../entities/payment.entity';
import { Invoice, InvoiceStatus } from '../entities/invoice.entity';
import { randomUUID } from 'crypto';

/**
 * Helper function for safe decimal arithmetic
 * Converts to integer cents first, then performs math to avoid floating point errors
 */
function safeAdd(a: number, b: number): number {
  return (Math.round(a * 100) + Math.round(b * 100)) / 100;
}

function safeSubtract(a: number, b: number): number {
  return (Math.round(a * 100) - Math.round(b * 100)) / 100;
}

@Injectable()
@CommandHandler(RecordPaymentCommand)
export class RecordPaymentHandler implements ICommandHandler<RecordPaymentCommand, Payment> {
  private readonly logger = new Logger(RecordPaymentHandler.name);

  constructor(
    private readonly dataSource: DataSource,
    @Optional() @Inject('EVENT_BUS') private readonly eventBus?: NatsEventBus,
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

      // ERROR HANDLING FIX: Validate amountDue to prevent NaN comparisons
      // Number(undefined) and Number(null) both return NaN, which breaks comparisons
      const amountDue = Number(invoice.amountDue);
      if (isNaN(amountDue)) {
        throw new BadRequestException(
          `Invoice ${input.invoiceId} has invalid amount due value`,
        );
      }

      // Use safe decimal comparison (convert to cents for comparison)
      if (input.amount > amountDue + 0.001) { // Small epsilon for floating point
        throw new BadRequestException(
          `Payment amount ${input.amount} exceeds amount due ${amountDue}`,
        );
      }

      // Generate transaction ID
      const transactionId = `TXN-${Date.now()}-${randomUUID().substring(0, 8).toUpperCase()}`;

      const payment = manager.create(Payment, {
        tenantId,
        transactionId,
        invoiceId: input.invoiceId,
        amount: input.amount,
        currency: input.currency || invoice.currency,
        status: PaymentStatus.SUCCEEDED,
        paymentMethod: input.paymentMethod,
        paymentMethodDetails: input.paymentMethodDetails,
        paymentDate: input.paymentDate ? new Date(input.paymentDate) : new Date(),
        processedAt: new Date(),
        stripePaymentIntentId: input.stripePaymentIntentId,
        stripeChargeId: input.stripeChargeId,
        notes: input.notes,
        refundedAmount: 0,
        createdBy: userId,
        updatedBy: userId,
      });

      const savedPayment = await manager.save(Payment, payment);

      // Update invoice with safe decimal arithmetic
      const newAmountPaid = safeAdd(Number(invoice.amountPaid), input.amount);
      const newAmountDue = safeSubtract(Number(invoice.total), newAmountPaid);

      invoice.amountPaid = newAmountPaid;
      invoice.amountDue = Math.max(0, newAmountDue); // Prevent negative due to rounding

      // Use small epsilon for "fully paid" check
      if (newAmountDue <= 0.01) {
        invoice.status = InvoiceStatus.PAID;
        invoice.paidAt = new Date();
        invoice.amountDue = 0; // Zero out any tiny remainder
      } else {
        invoice.status = InvoiceStatus.PARTIALLY_PAID;
      }

      invoice.updatedBy = userId;
      await manager.save(Invoice, invoice);

      this.logger.log(
        `Payment recorded: ${savedPayment.id} (${savedPayment.transactionId}) for invoice ${input.invoiceId}. Amount: ${input.amount}`,
      );

      // Publish NATS event so other services (notification, etc.) can react
      try {
        const event: PaymentReceivedEvent = {
          ...createBaseEvent<PaymentReceivedEvent>('PaymentReceived', tenantId, { userId }),
          paymentId: savedPayment.id,
          invoiceId: input.invoiceId,
          amount: savedPayment.amount,
          currency: savedPayment.currency,
          paymentMethod: savedPayment.paymentMethod,
          transactionId: savedPayment.transactionId,
          paidAt: savedPayment.paymentDate,
        };
        await this.eventBus?.publish(event);
      } catch (eventError) {
        // Event publish failure must not block the main operation
        this.logger.warn(
          `Failed to publish PaymentReceived event for ${savedPayment.id}: ${
            eventError instanceof Error ? eventError.message : 'Unknown error'
          }`,
        );
      }

      return savedPayment;
    });
  }
}
