export class ListPurchaseOrdersQuery {
  constructor(
    public readonly tenantId: string,
    public readonly category?: string,
    public readonly status?: string,
    public readonly page?: number,
    public readonly limit?: number,
  ) {}
}
