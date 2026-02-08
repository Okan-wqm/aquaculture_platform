export class GetPurchaseOrderQuery {
  constructor(
    public readonly id: string,
    public readonly tenantId: string,
  ) {}
}
