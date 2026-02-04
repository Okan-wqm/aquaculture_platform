/**
 * Get Feeding Protocol Query
 */
export class GetFeedingProtocolQuery {
  constructor(
    public readonly id: string,
    public readonly tenantId: string,
  ) {}
}
