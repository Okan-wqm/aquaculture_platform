/**
 * GetWarehouseSummaryQuery
 *
 * CQRS query for the mobile warehouse hub KPI data.
 * Separated from GetStorageOverviewQuery because the mobile hub needs
 * a different data shape (flat KPI counts + limited lists) than the
 * web panel overview (category totals, location fill rates, etc.).
 *
 * Tenant isolation: tenantId is extracted from JWT by the resolver
 * and passed as a constructor parameter -- never from user input.
 */
export class GetWarehouseSummaryQuery {
  constructor(
    public readonly tenantId: string,
  ) {}
}
