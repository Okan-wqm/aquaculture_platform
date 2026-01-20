import { RecordPaymentInput } from '../dto/record-payment.input';

export class RecordPaymentCommand {
  constructor(
    public readonly tenantId: string,
    public readonly input: RecordPaymentInput,
    public readonly userId: string,
  ) {}
}
