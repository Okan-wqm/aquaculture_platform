/**
 * Create Chemical Command
 * Uses DTOs for input types
 */
import { CreateChemicalInput as CreateChemicalInputDto } from '../dto/create-chemical.input';

export class CreateChemicalCommand {
  constructor(
    public readonly input: CreateChemicalInputDto,
    public readonly tenantId: string,
    public readonly userId: string,
  ) {}
}

// Re-export input type for convenience
export type CreateChemicalInput = CreateChemicalInputDto;
