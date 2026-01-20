/**
 * Get System Query
 */
export class GetSystemQuery {
  constructor(
    public readonly systemId: string,
    public readonly tenantId: string,
    public readonly includeRelations: boolean = false,
  ) {}
}
