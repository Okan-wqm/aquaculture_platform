export class GetCurrentlyOffshoreQuery {
  constructor(
    public readonly tenantId: string,
    public readonly workAreaId?: string,
  ) {}
}
