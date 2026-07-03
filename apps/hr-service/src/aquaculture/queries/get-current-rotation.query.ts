export class GetCurrentRotationQuery {
  constructor(
    public readonly tenantId: string,
    public readonly employeeId: string,
  ) {}
}
