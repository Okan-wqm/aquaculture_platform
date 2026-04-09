import { Injectable, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { AuditedOperation } from '@aquaculture/backend-common';
import { VoidInvoiceCommand } from '../commands/void-invoice.command';
import { Invoice, InvoiceStatus } from '../entities/invoice.entity';

/** Statuses from which an invoice may be voided */
const VOIDABLE_STATUSES = [
  InvoiceStatus.DRAFT,
  InvoiceStatus.PENDING,
  InvoiceStatus.SENT,
  InvoiceStatus.OVERDUE,
];

const MAX_VOID_REASON_LENGTH = 500;

@AuditedOperation({ resource: 'Invoice', action: 'VOID' })
@Injectable()
@CommandHandler(VoidInvoiceCommand)
export class VoidInvoiceHandler implements ICommandHandler<VoidInvoiceCommand, Invoice> {
  private readonly logger = new Logger(VoidInvoiceHandler.name);

  constructor(private readonly dataSource: DataSource) {}

  async execute(command: VoidInvoiceCommand): Promise<Invoice> {
    const { tenantId, invoiceId, reason, userId } = command;

    if (!reason || reason.trim().length === 0) {
      throw new BadRequestException('A reason must be provided when voiding an invoice');
    }

    if (reason.length > MAX_VOID_REASON_LENGTH) {
      throw new BadRequestException(
        `Void reason must not exceed ${MAX_VOID_REASON_LENGTH} characters`,
      );
    }

    return await this.dataSource.transaction(async (manager) => {
      const invoice = await manager.findOne(Invoice, {
        where: { id: invoiceId, tenantId },
        lock: { mode: 'pessimistic_write' },
      });

      if (!invoice) {
        throw new NotFoundException(`Invoice ${invoiceId} not found`);
      }

      if (!VOIDABLE_STATUSES.includes(invoice.status)) {
        throw new BadRequestException(
          `Cannot void invoice with status ${invoice.status}. Only unpaid invoices can be voided.`,
        );
      }

      invoice.status = InvoiceStatus.VOID;
      // Store void reason in the notes field (append to existing notes if present)
      const voidNote = `[VOIDED] ${reason}`;
      invoice.notes = invoice.notes ? `${invoice.notes}\n${voidNote}` : voidNote;
      invoice.updatedBy = userId;

      const saved = await manager.save(Invoice, invoice);

      this.logger.log(`Invoice voided: ${invoiceId} for tenant ${tenantId}. Reason: ${reason}`);

      return saved;
    });
  }
}
