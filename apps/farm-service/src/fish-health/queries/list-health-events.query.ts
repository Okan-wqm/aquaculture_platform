/**
 * List Health Events (filtered, paginated) Query
 */
import { HealthEventFilterInput } from '../dto/health-event-filter.input';
import type { TenantScope } from '@aquaculture/backend-common/database';

export class ListHealthEventsQuery {
  constructor(
    public readonly scope: TenantScope,
    public readonly filter?: HealthEventFilterInput,
  ) {}
}
