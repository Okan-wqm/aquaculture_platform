import { RefundPaymentInput } from '../dto/refund-payment.input';

export class RefundPaymentCommand {
  constructor(
    public readonly tenantId: string,
    public readonly input: RefundPaymentInput,
    public readonly userId: string,
  ) {}
}
