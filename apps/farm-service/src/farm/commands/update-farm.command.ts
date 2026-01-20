import { ICommand } from '@platform/cqrs';
import { LocationInput } from './create-farm.command';

/**
 * Update Farm Command
 * Command to update an existing farm
 */
export class UpdateFarmCommand implements ICommand {
  readonly commandName = 'UpdateFarm';

  constructor(
    public readonly farmId: string,
    public readonly tenantId: string,
    public readonly userId: string,
    public readonly name?: string,
    public readonly location?: LocationInput,
    public readonly address?: string,
    public readonly contactPerson?: string,
    public readonly contactPhone?: string,
    public readonly contactEmail?: string,
    public readonly description?: string,
    public readonly totalArea?: number,
    public readonly isActive?: boolean,
  ) {}
}
