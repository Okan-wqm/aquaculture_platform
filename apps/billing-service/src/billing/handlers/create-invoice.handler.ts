import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { CreateInvoiceCommand } from '../commands/create-invoice.command';
import { Invoice, InvoiceStatus, InvoiceLineItem } from '../entities/invoice.entity';
import { randomBytes } from 'crypto';

/**
 * Round to 2 decimal places for currency
 */
function roundCurrency(amount: number): number {
  return Math.round(amount * 100) / 100;
}

@Injectable()
@CommandHandler(CreateInvoiceCommand)
export class CreateInvoiceHandler implements ICommandHandler<CreateInvoiceCommand, Invoice> {
  private readonly logger = new Logger(CreateInvoiceHandler.name);

  constructor(
    @InjectRepository(Invoice)
    private readonly invoiceRepository: Repository<Invoice>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async execute(command: CreateInvoiceCommand): Promise<Invoice> {
    const { tenantId, input, userId } = command;

    // Validate line items are not empty
    if (!input.lineItems || input.lineItems.length === 0) {
      throw new BadRequestException('Invoice must have at least one line item');
    }

    // Calculate line items with amounts (rounded to 2 decimal places)
    const lineItems: InvoiceLineItem[] = input.lineItems.map((item) => ({
      description: item.description,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      amount: roundCurrency(item.quantity * item.unitPrice),
      productCode: item.productCode,
    }));

    // Calculate subtotal
    const subtotal = roundCurrency(lineItems.reduce((sum, item) => sum + item.amount, 0));

    // Calculate tax (rounded)
    let taxAmount = 0;
    if (input.tax) {
      taxAmount = roundCurrency(subtotal * (input.tax.taxRate / 100));
    }

    // Validate discount
    const discount = input.discount || 0;
    if (discount < 0) {
      throw new BadRequestException('Discount cannot be negative');
    }
    if (discount > subtotal + taxAmount) {
      throw new BadRequestException(
        `Discount (${discount}) cannot exceed subtotal + tax (${subtotal + taxAmount})`,
      );
    }

    // Calculate total (rounded)
    const total = roundCurrency(subtotal + taxAmount - discount);

    // Generate invoice number with collision-resistant approach
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

  /**
   * Generate invoice number with collision-resistant approach
   * Format: INV-{YYYYMM}-{tenantPrefix}-{timestamp+random}
   * Uses timestamp + random suffix instead of count to prevent race conditions
   */
  private async generateInvoiceNumber(tenantId: string): Promise<string> {
    const year = new Date().getFullYear();
    const month = String(new Date().getMonth() + 1).padStart(2, '0');
    // Use first 4 chars of tenant ID for prefix (helps identify tenant in logs)
    const tenantPrefix = tenantId.replace(/-/g, '').substring(0, 4).toUpperCase();
    // Use timestamp (base36 for compactness) + random suffix
    const timestamp = Date.now().toString(36).toUpperCase();
    const randomSuffix = randomBytes(2).toString('hex').toUpperCase();
    return `INV-${year}${month}-${tenantPrefix}-${timestamp}${randomSuffix}`;
  }
}
