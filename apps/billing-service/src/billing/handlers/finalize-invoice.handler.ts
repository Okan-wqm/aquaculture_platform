import { Injectable, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { AuditedOperation } from '@aquaculture/backend-common/audit';
import { StripeApiService } from '@aquaculture/backend-common/billing';
import { FinalizeInvoiceCommand } from '../commands/finalize-invoice.command';
import { Invoice, InvoiceStatus } from '../entities/invoice.entity';

@AuditedOperation({ resource: 'Invoice', action: 'FINALIZE' })
@Injectable()
@CommandHandler(FinalizeInvoiceCommand)
export class FinalizeInvoiceHandler implements ICommandHandler<FinalizeInvoiceCommand, Invoice> {
  private readonly logger = new Logger(FinalizeInvoiceHandler.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly stripeApi: StripeApiService,
  ) {}

  async execute(command: FinalizeInvoiceCommand): Promise<Invoice> {
    const { tenantId, invoiceId, userId } = command;

    return await this.dataSource.transaction(async (manager) => {
      const invoice = await manager.findOne(Invoice, {
        where: { id: invoiceId, tenantId },
        lock: { mode: 'pessimistic_write' },
      });

      if (!invoice) {
        throw new NotFoundException(`Invoice ${invoiceId} not found`);
      }

      if (invoice.status !== InvoiceStatus.DRAFT) {
        throw new BadRequestException(
          `Only DRAFT invoices can be finalized. Current status: ${invoice.status}`,
        );
      }

      // W1.1 (SSOT-C-12): when this invoice is mirrored to Stripe, finalize it at
      // Stripe too (issues it to the customer + triggers Stripe's collection) —
      // BEFORE flipping the local status, so a Stripe failure leaves the invoice
      // DRAFT (fail-closed, no local/Stripe divergence). Idempotent on the Stripe
      // invoice id. Local-only invoices (no stripeInvoiceId) finalize locally.
      if (invoice.stripeInvoiceId) {
        await this.stripeApi.finalizeInvoice({
          tenantId,
          invoiceId: invoice.stripeInvoiceId,
          idempotencyKey: `invoice-finalize:${invoice.stripeInvoiceId}`,
        });
      }

      invoice.status = InvoiceStatus.SENT;
      invoice.updatedBy = userId;

      const saved = await manager.save(Invoice, invoice);

      this.logger.log(`Invoice finalized: ${invoiceId} for tenant ${tenantId}`);

      return saved;
    });
  }
}
