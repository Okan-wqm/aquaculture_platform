export class GetRotationChangeoversQuery {
  constructor(
    public readonly tenantId: string,
    public readonly startDate: string,
    public readonly endDate: string,
  ) {}
}
