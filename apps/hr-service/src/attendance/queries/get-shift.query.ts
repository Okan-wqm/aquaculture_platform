export class GetShiftQuery {
  constructor(
    public readonly tenantId: string,
    public readonly id: string,
  ) {}
}
