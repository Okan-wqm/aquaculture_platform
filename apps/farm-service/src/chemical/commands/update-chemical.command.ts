/**
 * Update Chemical Command
 * Uses DTOs for input types
 */
import { UpdateChemicalInput as UpdateChemicalInputDto } from '../dto/update-chemical.input';

export class UpdateChemicalCommand {
  constructor(
    public readonly chemicalId: string,
    public readonly input: UpdateChemicalInputDto,
    public readonly tenantId: string,
    public readonly userId: string,
  ) {}
}

// Re-export input type for convenience
export type UpdateChemicalInput = UpdateChemicalInputDto;
