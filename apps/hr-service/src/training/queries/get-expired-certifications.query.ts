export class GetExpiredCertificationsQuery {
  constructor(
    public readonly tenantId: string,
    public readonly departmentId?: string,
  ) {}
}
