/**
 * Create System Command
 */
import { CreateSystemInput as CreateSystemInputDto } from '../dto/create-system.input';

export class CreateSystemCommand {
  constructor(
    public readonly input: CreateSystemInputDto,
    public readonly tenantId: string,
    public readonly userId: string,
  ) {}
}

export type CreateSystemInput = CreateSystemInputDto;
