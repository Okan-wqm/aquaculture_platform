/**
 * Get Supplier Query
 */
export class GetSupplierQuery {
  constructor(
    public readonly supplierId: string,
    public readonly tenantId: string,
  ) {}
}
