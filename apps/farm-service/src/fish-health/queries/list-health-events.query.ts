/**
 * List Health Events (filtered, paginated) Query
 */
import { IQuery } from '@platform/cqrs';
import { HealthEventFilterInput } from '../dto/health-event-filter.input';

export class ListHealthEventsQuery implements IQuery {
  constructor(
    public readonly tenantId: string,
    public readonly filter?: HealthEventFilterInput,
  ) {}
}
