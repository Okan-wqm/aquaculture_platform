/**
 * Create Site Command
 * Uses DTOs for input types
 */
import { ICommand } from '@platform/cqrs';
import { CreateSiteInput as CreateSiteInputDto } from '../dto/create-site.input';

export class CreateSiteCommand implements ICommand {
  constructor(
    public readonly input: CreateSiteInputDto,
    public readonly tenantId: string,
    public readonly userId: string,
    /**
     * SSOT-C-13: tenant plan tier ordinal (PLAN_LEVEL) for per-plan farm-count
     * quota enforcement. Undefined for platform SUPER_ADMIN → quota skipped.
     */
    public readonly planLevel?: number,
  ) {}
}

// Re-export input type for convenience
export type CreateSiteInput = CreateSiteInputDto;
