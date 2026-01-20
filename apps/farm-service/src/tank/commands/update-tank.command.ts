/**
 * Update Tank Command
 * @module Tank/Commands
 */
import { ICommand } from '@platform/cqrs';
import { UpdateTankInput } from '../dto/update-tank.dto';

export class UpdateTankCommand implements ICommand {
  constructor(
    public readonly tenantId: string,
    public readonly userId: string,
    public readonly input: UpdateTankInput,
  ) {}
}
