/**
 * List lice counts, optionally narrowed to a site/tank and an ISO
 * reporting year+week (the lakselus assembler's access path).
 */
export class ListLiceCountsQuery {
  constructor(
    public readonly tenantId: string,
    public readonly siteId?: string,
    public readonly tankId?: string,
    public readonly reportingYear?: number,
    public readonly reportingWeek?: number,
  ) {}
}
