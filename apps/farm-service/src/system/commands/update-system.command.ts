/**
 * Update System Command
 */
import { UpdateSystemInput as UpdateSystemInputDto } from '../dto/update-system.input';

export class UpdateSystemCommand {
  constructor(
    public readonly input: UpdateSystemInputDto,
    public readonly tenantId: string,
    public readonly userId: string,
  ) {}
}

export type UpdateSystemInput = UpdateSystemInputDto;
