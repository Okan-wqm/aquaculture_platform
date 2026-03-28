export class GetInventoryCountQuery {
  constructor(
    public readonly id: string,
    public readonly tenantId: string,
  ) {}
}
