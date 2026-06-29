/**
 * List Tasks Query
 */
import { IQuery } from '@platform/cqrs';
import { TaskFilterInput } from '../dto/task-filter.dto';

export class ListTasksQuery implements IQuery {
  constructor(
    public readonly tenantId: string,
    public readonly filter?: TaskFilterInput,
  ) {}
}
