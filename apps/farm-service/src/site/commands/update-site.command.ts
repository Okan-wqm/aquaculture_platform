/**
 * Update Site Command
 * Uses DTOs for input types
 */
import { ICommand } from '@nestjs/cqrs';
import { UpdateSiteInput as UpdateSiteInputDto } from '../dto/update-site.input';

export class UpdateSiteCommand implements ICommand {
  constructor(
    public readonly siteId: string,
    public readonly input: UpdateSiteInputDto,
    public readonly tenantId: string,
    public readonly userId: string,
  ) {}
}

// Re-export input type for convenience
export type UpdateSiteInput = UpdateSiteInputDto;
