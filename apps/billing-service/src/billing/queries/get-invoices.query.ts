import { InvoiceStatus } from '../entities/invoice.entity';

export interface InvoiceFilterInput {
  status?: InvoiceStatus;
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
