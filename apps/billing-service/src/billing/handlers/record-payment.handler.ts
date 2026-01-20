import { Injectable, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { RecordPaymentCommand } from '../commands/record-payment.command';
import { Payment, PaymentStatus } from '../entities/payment.entity';
import { Invoice, InvoiceStatus } from '../entities/invoice.entity';
import { randomUUID } from 'crypto';

@Injectable()
@CommandHandler(RecordPaymentCommand)
export class RecordPaymentHandler implements ICommandHandler<RecordPaymentCommand, Payment> {
  private readonly logger = new Logger(RecordPaymentHandler.name);

  constructor(
    @InjectRepository(Payment)
    private readonly paymentRepository: Repository<Payment>,
    @InjectRepository(Invoice)
    private readonly invoiceRepository: Repository<Invoice>,
  ) {}

  async execute(command: RecordPaymentCommand): Promise<Payment> {
    const { tenantId, input, userId } = command;

    // Verify invoice exists
    const invoice = await this.invoiceRepository.findOne({
      where: { id: input.invoiceId, tenantId },
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

    // Validate payment amount
    if (input.amount > Number(invoice.amountDue)) {
      throw new BadRequestException(
        `Payment amount ${input.amount} exceeds amount due ${invoice.amountDue}`,
      );
    }

    // Generate transaction ID
    const transactionId = `TXN-${Date.now()}-${randomUUID().substring(0, 8).toUpperCase()}`;

    const payment = this.paymentRepository.create({
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

    const savedPayment = await this.paymentRepository.save(payment);

    // Update invoice
    const newAmountPaid = Number(invoice.amountPaid) + input.amount;
    const newAmountDue = Number(invoice.total) - newAmountPaid;

    invoice.amountPaid = newAmountPaid;
    invoice.amountDue = newAmountDue;

    if (newAmountDue <= 0) {
      invoice.status = InvoiceStatus.PAID;
      invoice.paidAt = new Date();
    } else {
      invoice.status = InvoiceStatus.PARTIALLY_PAID;
    }

    invoice.updatedBy = userId;
    await this.invoiceRepository.save(invoice);

    this.logger.log(
      `Payment recorded: ${savedPayment.id} (${savedPayment.transactionId}) for invoice ${input.invoiceId}. Amount: ${input.amount}`,
    );

    return savedPayment;
  }
}
