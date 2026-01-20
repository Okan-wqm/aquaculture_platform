/**
 * Update Supplier Command
 * Uses DTOs for input types
 */
import { UpdateSupplierInput as UpdateSupplierInputDto } from '../dto/update-supplier.input';

export class UpdateSupplierCommand {
  constructor(
    public readonly supplierId: string,
    public readonly input: UpdateSupplierInputDto,
    public readonly tenantId: string,
    public readonly userId: string,
  ) {}
}

// Re-export input type for convenience
export type UpdateSupplierInput = UpdateSupplierInputDto;
