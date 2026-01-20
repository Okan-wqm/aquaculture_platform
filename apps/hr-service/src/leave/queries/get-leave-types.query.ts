export class GetLeaveTypesQuery {
  constructor(
    public readonly tenantId: string,
    public readonly isActive?: boolean,
    public readonly category?: string,
  ) {}
}
