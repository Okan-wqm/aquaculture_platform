/**
 * Update Feed Command
 * Uses DTOs for input types
 */
import { UpdateFeedInput as UpdateFeedInputDto } from '../dto/update-feed.input';

export class UpdateFeedCommand {
  constructor(
    public readonly feedId: string,
    public readonly input: UpdateFeedInputDto,
    public readonly tenantId: string,
    public readonly userId: string,
  ) {}
}

// Re-export input type for convenience
export type UpdateFeedInput = UpdateFeedInputDto;
