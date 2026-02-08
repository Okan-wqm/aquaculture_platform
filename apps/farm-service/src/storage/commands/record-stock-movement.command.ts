import { RecordStockMovementInput } from '../dto/record-stock-movement.input';

export class RecordStockMovementCommand {
  constructor(
    public readonly input: RecordStockMovementInput,
    public readonly tenantId: string,
    public readonly userId: string,
  ) {}
}
