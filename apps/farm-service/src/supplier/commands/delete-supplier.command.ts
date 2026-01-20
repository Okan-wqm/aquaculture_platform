/**
 * Delete Supplier Command
 */
export class DeleteSupplierCommand {
  constructor(
    public readonly supplierId: string,
    public readonly tenantId: string,
    public readonly userId: string,
  ) {}
}
