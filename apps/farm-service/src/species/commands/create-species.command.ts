/**
 * Create Species Command
 * @module Species/Commands
 */
import { ICommand } from '@platform/cqrs';
import { CreateSpeciesInput } from '../dto/create-species.dto';

export class CreateSpeciesCommand implements ICommand {
  constructor(
    public readonly tenantId: string,
    public readonly userId: string,
    public readonly input: CreateSpeciesInput,
  ) {}
}
