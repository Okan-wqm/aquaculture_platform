/**
 * Update Species Command
 * @module Species/Commands
 */
import { ICommand } from '@platform/cqrs';
import { UpdateSpeciesInput } from '../dto/update-species.dto';

export class UpdateSpeciesCommand implements ICommand {
  constructor(
    public readonly tenantId: string,
    public readonly userId: string,
    public readonly input: UpdateSpeciesInput,
  ) {}
}
