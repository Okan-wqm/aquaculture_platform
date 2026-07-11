export class GetFinanceBatchTotalsQuery {
  constructor(
    public readonly tenantId: string,
    public readonly from: Date,
    public readonly to: Date,
  ) {}
}
