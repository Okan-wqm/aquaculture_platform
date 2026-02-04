/**
 * Create Feeding Protocol Command
 */
import { CreateFeedingProtocolInput as CreateFeedingProtocolInputDto } from '../dto/create-feeding-protocol.input';

export class CreateFeedingProtocolCommand {
  constructor(
    public readonly input: CreateFeedingProtocolInputDto,
    public readonly tenantId: string,
    public readonly userId: string,
  ) {}
}

// Re-export input type for convenience
export type CreateFeedingProtocolInput = CreateFeedingProtocolInputDto;
