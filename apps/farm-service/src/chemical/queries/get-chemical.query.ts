/**
 * Get Chemical Query
 */
export class GetChemicalQuery {
  constructor(
    public readonly chemicalId: string,
    public readonly tenantId: string,
  ) {}
}
