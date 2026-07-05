/** Fetch a single persisted regulatory report submission by id. */
export class GetRegulatoryReportQuery {
  constructor(
    public readonly tenantId: string,
    public readonly id: string,
  ) {}
}
