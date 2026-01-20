/**
 * Update Tank Status Command
 * @module Tank/Commands
 */
import { ICommand } from '@platform/cqrs';
import { UpdateTankStatusInput } from '../dto/update-tank-status.dto';

export class UpdateTankStatusCommand implements ICommand {
  constructor(
    public readonly tenantId: string,
    public readonly userId: string,
    public readonly input: UpdateTankStatusInput,
  ) {}
}
