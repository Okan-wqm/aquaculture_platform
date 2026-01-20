/**
 * Get Site Query
 */
import { IQuery } from '@nestjs/cqrs';

export class GetSiteQuery implements IQuery {
  constructor(
    public readonly siteId: string,
    public readonly tenantId: string,
    public readonly includeRelations?: boolean,
  ) {}
}
