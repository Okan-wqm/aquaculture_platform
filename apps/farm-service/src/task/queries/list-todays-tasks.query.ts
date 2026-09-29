/**
 * List Today's Tasks Query
 */
import type { TenantScope } from '@aquaculture/backend-common/database';

export class ListTodaysTasksQuery {
  constructor(public readonly scope: TenantScope) {}
}
