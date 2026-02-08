import { ReceiveDeliveryInput } from '../dto/receive-delivery.input';

export class ReceiveDeliveryCommand {
  constructor(
    public readonly input: ReceiveDeliveryInput,
    public readonly tenantId: string,
    public readonly userId: string,
  ) {}
}
