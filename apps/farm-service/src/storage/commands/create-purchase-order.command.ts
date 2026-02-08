import { CreatePurchaseOrderInput } from '../dto/create-purchase-order.input';

export class CreatePurchaseOrderCommand {
  constructor(
    public readonly input: CreatePurchaseOrderInput,
    public readonly tenantId: string,
    public readonly userId: string,
  ) {}
}
