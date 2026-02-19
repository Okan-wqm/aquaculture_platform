import { InvoiceStatus } from '../entities/invoice.entity';

export interface InvoiceFilterInput {
  status?: InvoiceStatus;
  /** Multiple statuses for combined queries (e.g., unpaid invoices) */
  statuses?: InvoiceStatus[];
  startDate?: Date;
  endDate?: Date;
  offset?: number;
  limit?: number;
  /** Include payment details in response - defaults to false for performance */
  includePayments?: boolean;
}

export class GetInvoicesQuery {
  constructor(
    public readonly tenantId: string,
    public readonly filter?: InvoiceFilterInput,
  ) {}
}
