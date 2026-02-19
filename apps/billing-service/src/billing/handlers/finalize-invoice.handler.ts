import { Injectable, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { FinalizeInvoiceCommand } from '../commands/finalize-invoice.command';
import { Invoice, InvoiceStatus } from '../entities/invoice.entity';

@Injectable()
@CommandHandler(FinalizeInvoiceCommand)
export class FinalizeInvoiceHandler implements ICommandHandler<FinalizeInvoiceCommand, Invoice> {
  private readonly logger = new Logger(FinalizeInvoiceHandler.name);

  constructor(private readonly dataSource: DataSource) {}

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

      invoice.status = InvoiceStatus.SENT;
      invoice.updatedBy = userId;

      const saved = await manager.save(Invoice, invoice);

      this.logger.log(`Invoice finalized: ${invoiceId} for tenant ${tenantId}`);

      return saved;
    });
  }
}
