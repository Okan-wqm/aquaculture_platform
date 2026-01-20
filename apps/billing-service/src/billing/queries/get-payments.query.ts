import { PaymentStatus } from '../entities/payment.entity';

export interface PaymentFilterInput {
  invoiceId?: string;
  status?: PaymentStatus;
  startDate?: Date;
  endDate?: Date;
  offset?: number;
  limit?: number;
}

export class GetPaymentsQuery {
  constructor(
    public readonly tenantId: string,
    public readonly filter?: PaymentFilterInput,
  ) {}
}
