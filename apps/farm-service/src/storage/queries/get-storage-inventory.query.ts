export class GetStorageInventoryQuery {
  constructor(
    public readonly tenantId: string,
    public readonly locationId?: string,
    public readonly itemType?: string,
    /** Max number of rows to return (default 100, max 500) */
    public readonly limit?: number,
    /** Number of rows to skip for offset-based pagination */
    public readonly offset?: number,
  ) {}
}
