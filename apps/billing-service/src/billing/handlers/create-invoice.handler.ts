import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { CreateInvoiceCommand } from '../commands/create-invoice.command';
import { Invoice, InvoiceStatus, InvoiceLineItem } from '../entities/invoice.entity';

@Injectable()
@CommandHandler(CreateInvoiceCommand)
export class CreateInvoiceHandler implements ICommandHandler<CreateInvoiceCommand, Invoice> {
  private readonly logger = new Logger(CreateInvoiceHandler.name);

  constructor(
    @InjectRepository(Invoice)
    private readonly invoiceRepository: Repository<Invoice>,
  ) {}

  async execute(command: CreateInvoiceCommand): Promise<Invoice> {
    const { tenantId, input, userId } = command;

    // Calculate line items with amounts
    const lineItems: InvoiceLineItem[] = input.lineItems.map((item) => ({
      description: item.description,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      amount: item.quantity * item.unitPrice,
      productCode: item.productCode,
    }));

    // Calculate subtotal
    const subtotal = lineItems.reduce((sum, item) => sum + item.amount, 0);

    // Calculate tax
    let taxAmount = 0;
    if (input.tax) {
      taxAmount = subtotal * (input.tax.taxRate / 100);
    }

    // Calculate total
    const discount = input.discount || 0;
    const total = subtotal + taxAmount - discount;

    // Generate invoice number
    const invoiceNumber = await this.generateInvoiceNumber(tenantId);

    const invoice = this.invoiceRepository.create({
      tenantId,
      invoiceNumber,
      subscriptionId: input.subscriptionId,
      status: InvoiceStatus.DRAFT,
      billingAddress: {
        companyName: input.billingAddress.companyName,
        attention: input.billingAddress.attention,
        street: input.billingAddress.street,
        city: input.billingAddress.city,
        state: input.billingAddress.state,
        postalCode: input.billingAddress.postalCode,
        country: input.billingAddress.country,
        taxId: input.billingAddress.taxId,
      },
      lineItems,
      subtotal,
      tax: input.tax
        ? {
            taxRate: input.tax.taxRate,
            taxAmount,
            taxId: input.tax.taxId,
            taxName: input.tax.taxName,
          }
        : undefined,
      discount,
      discountCode: input.discountCode,
      total,
      amountPaid: 0,
      amountDue: total,
      currency: input.currency || 'USD',
      issueDate: new Date(),
      dueDate: new Date(input.dueDate),
      periodStart: new Date(input.periodStart),
      periodEnd: new Date(input.periodEnd),
      notes: input.notes,
      createdBy: userId,
      updatedBy: userId,
    });

    const savedInvoice = await this.invoiceRepository.save(invoice);

    this.logger.log(
      `Invoice created: ${savedInvoice.id} (${savedInvoice.invoiceNumber}) for tenant ${tenantId}`,
    );

    return savedInvoice;
  }

  private async generateInvoiceNumber(tenantId: string): Promise<string> {
    const count = await this.invoiceRepository.count({ where: { tenantId } });
    const year = new Date().getFullYear();
    const month = String(new Date().getMonth() + 1).padStart(2, '0');
    const sequence = String(count + 1).padStart(6, '0');
    return `INV-${year}${month}-${sequence}`;
  }
}
