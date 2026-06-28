export class GetCertificationComplianceReportQuery {
  constructor(
    public readonly tenantId: string,
    public readonly departmentId?: string,
  ) {}
}
