/**
 * Create Site Command
 * Uses DTOs for input types
 */
import { ICommand } from '@nestjs/cqrs';
import { CreateSiteInput as CreateSiteInputDto } from '../dto/create-site.input';

export class CreateSiteCommand implements ICommand {
  constructor(
    public readonly input: CreateSiteInputDto,
    public readonly tenantId: string,
    public readonly userId: string,
  ) {}
}

// Re-export input type for convenience
export type CreateSiteInput = CreateSiteInputDto;
