import { TransferStockInput } from '../dto/transfer-stock.input';

export class TransferStockCommand {
  constructor(
    public readonly input: TransferStockInput,
    public readonly tenantId: string,
    public readonly userId: string,
    /** Denormalized user display name from JWT for audit trail */
    public readonly userName?: string,
  ) {}
}
