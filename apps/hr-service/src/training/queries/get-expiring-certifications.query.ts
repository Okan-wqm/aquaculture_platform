export class GetExpiringCertificationsQuery {
  constructor(
    public readonly tenantId: string,
    public readonly daysUntilExpiry: number = 30,
    public readonly departmentId?: string,
  ) {}
}
