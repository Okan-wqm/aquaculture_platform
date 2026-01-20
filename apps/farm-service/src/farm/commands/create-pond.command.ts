import { ICommand } from '@platform/cqrs';
import { WaterType, PondStatus } from '../entities/pond.entity';

/**
 * Create Pond Command
 * Command to add a new pond to a farm
 */
export class CreatePondCommand implements ICommand {
  readonly commandName = 'CreatePond';

  constructor(
    public readonly name: string,
    public readonly farmId: string,
    public readonly capacity: number,
    public readonly tenantId: string,
    public readonly userId: string,
    public readonly waterType?: WaterType,
    public readonly depth?: number,
    public readonly surfaceArea?: number,
    public readonly status?: PondStatus,
  ) {}
}
