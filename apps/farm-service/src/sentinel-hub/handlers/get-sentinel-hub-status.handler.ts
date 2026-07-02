/**
 * Get Sentinel Hub Status Query Handler — fail-closed tenant boundary
 * (FARM-HIGH-060). Thin CQRS delegator to SentinelHubService.getStatus, whose
 * settings read now runs inside runInTenantRead. The credential masking stays in
 * the service (no secret handling leaves it).
 */
import { QueryHandler, IQueryHandler } from '@platform/cqrs';

import { SentinelHubStatus } from '../entities/sentinel-hub-settings.entity';
import { SentinelHubService } from '../sentinel-hub.service';
import { GetSentinelHubStatusQuery } from '../queries/get-sentinel-hub-status.query';

@QueryHandler(GetSentinelHubStatusQuery)
export class GetSentinelHubStatusHandler implements IQueryHandler<GetSentinelHubStatusQuery> {
  constructor(private readonly sentinelHubService: SentinelHubService) {}

  async execute(query: GetSentinelHubStatusQuery): Promise<SentinelHubStatus> {
    return this.sentinelHubService.getStatus(query.tenantId);
  }
}
