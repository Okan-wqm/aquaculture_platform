import { UpdatePurchaseOrderStatusInput } from '../dto/update-purchase-order-status.input';

export class UpdatePurchaseOrderStatusCommand {
  constructor(
    public readonly input: UpdatePurchaseOrderStatusInput,
    public readonly tenantId: string,
    public readonly userId: string,
  ) {}
}
