/**
 * Create Supplier Command
 * Uses DTOs for input types
 */
import { CreateSupplierInput as CreateSupplierInputDto } from '../dto/create-supplier.input';

export class CreateSupplierCommand {
  constructor(
    public readonly input: CreateSupplierInputDto,
    public readonly tenantId: string,
    public readonly userId: string,
  ) {}
}

// Re-export input type for convenience
export type CreateSupplierInput = CreateSupplierInputDto;
