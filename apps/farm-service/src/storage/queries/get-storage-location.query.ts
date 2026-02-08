export class GetStorageLocationQuery {
  constructor(
    public readonly locationId: string,
    public readonly tenantId: string,
  ) {}
}
