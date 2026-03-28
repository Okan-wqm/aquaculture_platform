import { RecordStockMovementInput } from '../dto/record-stock-movement.input';

export class RecordStockMovementCommand {
  constructor(
    public readonly input: RecordStockMovementInput,
    public readonly tenantId: string,
    public readonly userId: string,
    /** Denormalized user display name from JWT for audit trail */
    public readonly userName?: string,
  ) {}
}
