/**
 * Is Sentinel Hub Configured Query Handler — fail-closed tenant boundary
 * (FARM-HIGH-060). Thin CQRS delegator to SentinelHubService.isConfigured
 * (settings read wrapped in runInTenantRead).
 */
import { QueryHandler, IQueryHandler } from '@platform/cqrs';

import { SentinelHubService } from '../sentinel-hub.service';
import { IsSentinelHubConfiguredQuery } from '../queries/is-sentinel-hub-configured.query';

@QueryHandler(IsSentinelHubConfiguredQuery)
export class IsSentinelHubConfiguredHandler
  implements IQueryHandler<IsSentinelHubConfiguredQuery>
{
  constructor(private readonly sentinelHubService: SentinelHubService) {}

  async execute(query: IsSentinelHubConfiguredQuery): Promise<boolean> {
    return this.sentinelHubService.isConfigured(query.tenantId);
  }
}
