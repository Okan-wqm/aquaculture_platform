/**
 * PURE projections for the task farm-AI responder (PR-5, Operations
 * specialist). Covers today's tasks and the task statistics aggregate.
 *
 * Rules of the read-only namespace (see common/nats/ai-query-responder.ts):
 *  - Input = the query handler's return shape; output = wire DTO ONLY.
 *  - NO operator PII (assignedTo, assignedToName, createdBy, notes,
 *    checklistItems, description) — the AI persona answers about the work,
 *    never about the workers.
 *  - Dates → ISO strings (or null); numbers keep their unit in the name.
 */
import { Task } from '../entities/task.entity';
import { isoOrNull } from '../../common/nats/ai-query-responder';

/** One of today's tasks. */
export interface TaskDto {
  id: string;
  title: string;
  category: string;
  priority: string;
  status: string;
  dueDate: string | null;
  dueTime: string | null;
  siteId: string | null;
  location: string | null;
  estimatedMinutes: number | null;
  tags: string[];
  isRecurring: boolean;
}

/**
 * Project a task row. Assignee/creator identity, notes, checklist items and
 * the free-text description are stripped by construction.
 */
export function projectTask(
  row: Pick<
    Task,
    | 'id'
    | 'title'
    | 'category'
    | 'priority'
    | 'status'
    | 'dueDate'
    | 'dueTime'
    | 'siteId'
    | 'location'
    | 'estimatedMinutes'
    | 'tags'
    | 'isRecurring'
  >,
): TaskDto {
  return {
    id: row.id,
    title: row.title,
    category: String(row.category),
    priority: String(row.priority),
    status: String(row.status),
    dueDate: isoOrNull(row.dueDate),
    dueTime: row.dueTime ?? null,
    siteId: row.siteId ?? null,
    location: row.location ?? null,
    estimatedMinutes: row.estimatedMinutes ?? null,
    tags: Array.isArray(row.tags) ? row.tags.slice() : [],
    isRecurring: row.isRecurring === true,
  };
}
