/**
 * UpdateBatchWeightFromSampleCommand
 *
 * Ölçüm sonucuna göre batch ağırlığını güncellemek için command.
 *
 * @module Growth/Commands
 */
import { ITenantCommand } from '@platform/cqrs';

export class UpdateBatchWeightFromSampleCommand implements ITenantCommand {
  readonly commandName = 'UpdateBatchWeightFromSampleCommand';

  constructor(
    public readonly tenantId: string,
    public readonly batchId: string,
    public readonly measurementId: string,
    public readonly userId: string,
  ) {}
}
