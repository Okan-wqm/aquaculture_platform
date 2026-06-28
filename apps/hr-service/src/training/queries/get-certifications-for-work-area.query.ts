export class GetCertificationsForWorkAreaQuery {
  constructor(
    public readonly tenantId: string,
    public readonly workAreaId: string,
  ) {}
}
