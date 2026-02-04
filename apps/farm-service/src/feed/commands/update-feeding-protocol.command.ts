/**
 * Update Feeding Protocol Command
 */
import { UpdateFeedingProtocolInput as UpdateFeedingProtocolInputDto } from '../dto/update-feeding-protocol.input';

export class UpdateFeedingProtocolCommand {
  constructor(
    public readonly id: string,
    public readonly input: UpdateFeedingProtocolInputDto,
    public readonly tenantId: string,
    public readonly userId: string,
  ) {}
}

// Re-export input type for convenience
export type UpdateFeedingProtocolInput = UpdateFeedingProtocolInputDto;
