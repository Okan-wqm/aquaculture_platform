/**
 * Is Sentinel Hub Configured Query
 */
import { IQuery } from '@platform/cqrs';

export class IsSentinelHubConfiguredQuery implements IQuery {
  constructor(public readonly tenantId: string) {}
}
