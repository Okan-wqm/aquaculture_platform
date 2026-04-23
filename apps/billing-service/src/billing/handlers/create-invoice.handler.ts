import { Injectable, Logger, BadRequestException, NotFoundException, Optional, Inject } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { NatsEventBus } from '@platform/event-bus';
import { createBaseEvent, InvoiceGeneratedEvent } from '@platform/event-contracts';
import { AuditedOperation, Money, TenantScopedRepository } from '@aquaculture/backend-common';
import Decimal from 'decimal.js';
import { CreateInvoiceCommand } from '../commands/create-invoice.command';
import { Invoice, InvoiceStatus, InvoiceLineItem } from '../entities/invoice.entity';
import { Subscription } from '../entities/subscription.entity';
import { randomBytes } from 'crypto';

@AuditedOperation({ resource: 'Invoice', action: 'CREATE' })
@Injectable()
@CommandHandler(CreateInvoiceCommand)
export class CreateInvoiceHandler implements ICommandHandler<CreateInvoiceCommand, Invoice> {
  private readonly logger = new Logger(CreateInvoiceHandler.name);

  constructor(
    private readonly dataSource: DataSource,
    @Optional() @Inject('EVENT_BUS') private readonly eventBus?: NatsEventBus,
  ) {}

  async execute(command: CreateInvoiceCommand): Promise<Invoice> {
    const { tenantId, input, userId } = command;

    const invoiceRepo = TenantScopedRepository.create(this.dataSource, Invoice, tenantId);

    // Validate subscription belongs to this tenant (IDOR prevention is
    // now by-construction via TenantScopedRepository — the scoped
    // findOne auto-filters by tenantId so a malicious subscriptionId
    // belonging to another tenant returns null).
    if (input.subscriptionId) {
      const subscriptionRepo = TenantScopedRepository.create(this.dataSource, Subscription, tenantId);
      const subscription = await subscriptionRepo.findOne({
        where: { id: input.subscriptionId },
      });
      if (!subscription) {
        throw new NotFoundException(
          `Subscription ${input.subscriptionId} not found for this tenant`,
        );
      }
    }

    // Validate line items are not empty
    if (!input.lineItems || input.lineItems.length === 0) {
      throw new BadRequestException('Invoice must have at least one line item');
    }

    const currency = input.currency || 'USD';

    // Calculate line items with amounts using Money for precision
    const lineItems: InvoiceLineItem[] = input.lineItems.map((item) => {
      const lineAmount = Money.of(item.unitPrice, currency).multiply(item.quantity);
      return {
        description: item.description,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        amount: lineAmount.toDecimal().toNumber(),
        productCode: item.productCode,
      };
    });

    // Calculate subtotal using Money
    const subtotalMoney = lineItems.reduce(
      (sum, item) => sum.add(Money.of(item.amount, currency)),
      Money.zero(currency),
    );

    // Calculate tax using Money
    let taxMoney = Money.zero(currency);
    if (input.tax) {
      taxMoney = subtotalMoney.multiply(input.tax.taxRate / 100);
    }

    // Validate discount
    // Discounts are applied to the pre-tax subtotal, consistent with MeteredBillingService.applyDiscount().
    const discountMoney = Money.of(input.discount || 0, currency);
    if (discountMoney.isNegative()) {
      throw new BadRequestException('Discount cannot be negative');
    }
    if (discountMoney.greaterThan(subtotalMoney)) {
      throw new BadRequestException(
        `Discount (${discountMoney}) cannot exceed subtotal (${subtotalMoney})`,
      );
    }

    // Recalculate tax on the discounted subtotal so the effective rate is applied consistently
    const discountedSubtotal = subtotalMoney.subtract(discountMoney);
    if (input.tax) {
      taxMoney = discountedSubtotal.multiply(input.tax.taxRate / 100);
    }

    // Calculate total using Money
    const totalMoney = discountedSubtotal.add(taxMoney);

    // Generate invoice number with collision-resistant approach
    const invoiceNumber = await this.generateInvoiceNumber(tenantId);

    const invoice = invoiceRepo.create({
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
      subtotal: subtotalMoney.toDecimal(),
      tax: input.tax
        ? {
            taxRate: input.tax.taxRate,
            taxAmount: taxMoney.toDecimal().toNumber(),
            taxId: input.tax.taxId,
            taxName: input.tax.taxName,
          }
        : undefined,
      discount: discountMoney.isZero() ? undefined : discountMoney.toDecimal(),
      discountCode: input.discountCode,
      total: totalMoney.toDecimal(),
      amountPaid: new Decimal(0),
      amountDue: totalMoney.toDecimal(),
      currency,
      issueDate: new Date(),
      dueDate: new Date(input.dueDate),
      periodStart: new Date(input.periodStart),
      periodEnd: new Date(input.periodEnd),
      notes: input.notes,
      createdBy: userId,
      updatedBy: userId,
    });

    const savedInvoice = await invoiceRepo.save(invoice);

    this.logger.log(
      `Invoice created: ${savedInvoice.id} (${savedInvoice.invoiceNumber}) for tenant ${tenantId}`,
    );

    // Publish NATS event so other services (notification, etc.) can react
    try {
      const event: InvoiceGeneratedEvent = {
        ...createBaseEvent<InvoiceGeneratedEvent>('InvoiceGenerated', tenantId, { userId }),
        invoiceId: savedInvoice.id,
        invoiceNumber: savedInvoice.invoiceNumber,
        subscriptionId: savedInvoice.subscriptionId || '',
        subtotal: savedInvoice.subtotal.toNumber(),
        tax: savedInvoice.tax?.taxAmount || 0,
        total: savedInvoice.total.toNumber(),
        currency: savedInvoice.currency,
        dueDate: savedInvoice.dueDate,
        billingPeriodStart: savedInvoice.periodStart,
        billingPeriodEnd: savedInvoice.periodEnd,
      };
      await this.eventBus?.publish(event);
    } catch (eventError) {
      // Event publish failure must not block the main operation
      this.logger.warn(
        `Failed to publish InvoiceGenerated event for ${savedInvoice.id}: ${
          eventError instanceof Error ? eventError.message : 'Unknown error'
        }`,
      );
    }

    return savedInvoice;
  }

  /**
   * Generate invoice number with collision-resistant approach
   * Format: INV-{YYYYMM}-{tenantPrefix}-{timestamp+random}
   * Uses timestamp + random suffix instead of count to prevent race conditions
   */
  private async generateInvoiceNumber(tenantId: string): Promise<string> {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    // Use first 4 chars of tenant ID for prefix (helps identify tenant in logs)
    const tenantPrefix = tenantId.replace(/-/g, '').substring(0, 4).toUpperCase();
    // Use timestamp (base36 for compactness) + random suffix
    const timestamp = Date.now().toString(36).toUpperCase();
    const randomSuffix = randomBytes(2).toString('hex').toUpperCase();
    return `INV-${year}${month}-${tenantPrefix}-${timestamp}${randomSuffix}`;
  }
}
