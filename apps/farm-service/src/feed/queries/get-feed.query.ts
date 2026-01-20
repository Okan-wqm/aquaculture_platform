/**
 * Get Feed Query
 */
export class GetFeedQuery {
  constructor(
    public readonly feedId: string,
    public readonly tenantId: string,
  ) {}
}
