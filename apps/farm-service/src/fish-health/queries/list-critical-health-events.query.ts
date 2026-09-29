/**
 * List Critical Health Events Query
 */
import type { TenantScope } from '@aquaculture/backend-common/database';

export class ListCriticalHealthEventsQuery {
  constructor(public readonly scope: TenantScope) {}
}
