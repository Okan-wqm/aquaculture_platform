/**
 * Create Feed Command
 * Uses DTOs for input types
 */
import { CreateFeedInput as CreateFeedInputDto } from '../dto/create-feed.input';

export class CreateFeedCommand {
  constructor(
    public readonly input: CreateFeedInputDto,
    public readonly tenantId: string,
    public readonly userId: string,
  ) {}
}

// Re-export input type for convenience
export type CreateFeedInput = CreateFeedInputDto;
