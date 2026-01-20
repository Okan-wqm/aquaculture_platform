/**
 * Get Site Delete Preview Query
 * Returns a preview of what will be deleted when a site is soft deleted
 */
import { IQuery } from '@nestjs/cqrs';

export class GetSiteDeletePreviewQuery implements IQuery {
  constructor(
    public readonly siteId: string,
    public readonly tenantId: string,
  ) {}
}
