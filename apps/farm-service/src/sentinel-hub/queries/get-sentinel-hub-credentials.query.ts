/**
 * Get Sentinel Hub Credentials Query (masked — never returns secrets)
 */
import { IQuery } from '@platform/cqrs';

export class GetSentinelHubCredentialsQuery implements IQuery {
  constructor(public readonly tenantId: string) {}
}
