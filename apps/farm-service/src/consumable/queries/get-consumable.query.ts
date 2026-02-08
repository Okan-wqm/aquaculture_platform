export class GetConsumableQuery {
  constructor(
    public readonly consumableId: string,
    public readonly tenantId: string,
  ) {}
}
