/**
 * Get Sentinel Hub Status Query
 */
import { IQuery } from '@platform/cqrs';

export class GetSentinelHubStatusQuery implements IQuery {
  constructor(public readonly tenantId: string) {}
}
