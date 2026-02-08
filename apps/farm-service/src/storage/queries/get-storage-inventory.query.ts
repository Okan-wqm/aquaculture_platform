export class GetStorageInventoryQuery {
  constructor(
    public readonly tenantId: string,
    public readonly locationId?: string,
    public readonly itemType?: string,
  ) {}
}
