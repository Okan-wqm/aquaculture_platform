/**
 * List My Tasks Query — tasks assigned to a specific user.
 */
import { IQuery } from '@platform/cqrs';
import { TaskStatus } from '../entities/task.entity';

export class ListMyTasksQuery implements IQuery {
  constructor(
    public readonly tenantId: string,
    public readonly userId: string,
    public readonly statuses?: TaskStatus[],
  ) {}
}
