/**
 * Get Sentinel Hub Credentials Query Handler — fail-closed tenant boundary
 * (FARM-HIGH-060). Thin CQRS delegator to SentinelHubService.getCredentials
 * (settings read wrapped in runInTenantRead; returns MASKED credentials — the
 * clientSecret is never exposed).
 */
import { QueryHandler, IQueryHandler } from '@platform/cqrs';

import { SentinelHubCredentials } from '../entities/sentinel-hub-settings.entity';
import { SentinelHubService } from '../sentinel-hub.service';
import { GetSentinelHubCredentialsQuery } from '../queries/get-sentinel-hub-credentials.query';

@QueryHandler(GetSentinelHubCredentialsQuery)
export class GetSentinelHubCredentialsHandler
  implements IQueryHandler<GetSentinelHubCredentialsQuery>
{
  constructor(private readonly sentinelHubService: SentinelHubService) {}

  async execute(query: GetSentinelHubCredentialsQuery): Promise<SentinelHubCredentials | null> {
    return this.sentinelHubService.getCredentials(query.tenantId);
  }
}
