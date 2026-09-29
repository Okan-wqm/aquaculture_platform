import { Controller, Logger } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import { runInTenantTransaction } from '@aquaculture/backend-common/database';
import { respondTenantBound } from '@aquaculture/backend-common/nats';
import { isRecord, type TenantBoundReply } from '@platform/event-contracts';
import { DataSource } from 'typeorm';
import { TaskService } from '../services/task.service';
import { TaskCategory, TaskPriority } from '../entities/task.entity';
import { CreateTaskInput } from '../dto/create-task.dto';

/**
 * Cross-service task creation over NATS request-reply. ai-service's
 * create_task tool (an actuation tool gated by the actuation policy) publishes
 * request.farm.createTask; this responder validates it and writes through the
 * SAME task-create SSoT the GraphQL resolver uses (TaskService.createWithManager),
 * inside a tenant-pinned transaction. There is no HTTP hop and no duplicated
 * task shape — the tool cannot bypass the outbox/event contract.
 */
export interface CreateTaskNatsRequest {
  tenantId: string;
  /** The user on whose behalf the AI is acting (creator + default assignee). */
  createdBy: string;
  assignedTo: string;
  assignedToName: string;
  title: string;
  description?: string;
  category: string;
  priority: string;
  /** ISO-8601 due date. */
  dueDate: string;
}

/**
 * Domain outcome of a create request. A rejection (unknown enum, empty title,
 * bad date) is DATA the model relays to the user, not a transport failure;
 * transport failures ride the tenant-bound envelope's `error` (K10).
 */
export type CreateTaskOutcome =
  | { created: true; taskId: string; title: string }
  | { created: false; reason: string };

const REQUIRED_STRING_FIELDS = [
  'tenantId',
  'createdBy',
  'assignedTo',
  'assignedToName',
  'title',
  'category',
  'priority',
  'dueDate',
] as const;

/** Contract guard: every field a string (description optional). Domain validation happens in create(). */
function isCreateTaskRequest(value: unknown): value is CreateTaskNatsRequest {
  if (!isRecord(value)) return false;
  const createdBy = value['createdBy'];
  const description = value['description'];
  return (
    REQUIRED_STRING_FIELDS.every((key) => typeof value[key] === 'string') &&
    typeof createdBy === 'string' &&
    createdBy.length > 0 &&
    (description === undefined || typeof description === 'string')
  );
}

@Controller()
export class CreateTaskResponder {
  private readonly logger = new Logger(CreateTaskResponder.name);

  constructor(
    private readonly taskService: TaskService,
    private readonly dataSource: DataSource,
  ) {}

  // K10 (MT-HIGH-062): the reply names the tenant the task was written to, so
  // ai-service can refuse an answer served for another tenant.
  @MessagePattern('request.farm.createTask')
  handleCreateTask(@Payload() payload: unknown): Promise<TenantBoundReply<CreateTaskOutcome>> {
    return respondTenantBound(
      this.logger,
      'request.farm.createTask',
      payload,
      isCreateTaskRequest,
      (request) => this.create(request),
    );
  }

  private async create(payload: CreateTaskNatsRequest): Promise<CreateTaskOutcome> {
    // Fail-closed validation: an actuation crossing a service boundary must not
    // trust the caller's strings. Reject anything the domain would not accept
    // rather than coercing it.
    const title = payload.title.trim();
    if (!title) {
      return { created: false, reason: 'A task title is required' };
    }
    if (!Object.values(TaskCategory).includes(payload.category as TaskCategory)) {
      return { created: false, reason: `Unknown task category "${payload.category}"` };
    }
    if (!Object.values(TaskPriority).includes(payload.priority as TaskPriority)) {
      return { created: false, reason: `Unknown task priority "${payload.priority}"` };
    }
    const dueDate = new Date(payload.dueDate);
    if (Number.isNaN(dueDate.getTime())) {
      return { created: false, reason: 'A valid ISO-8601 dueDate is required' };
    }

    const input: CreateTaskInput = {
      title,
      description: payload.description,
      category: payload.category as TaskCategory,
      priority: payload.priority as TaskPriority,
      assignedTo: payload.assignedTo || payload.createdBy,
      assignedToName: payload.assignedToName,
      dueDate: payload.dueDate,
    };

    const saved = await runInTenantTransaction(this.dataSource, 'farm', payload.tenantId, (qr) =>
      this.taskService.createWithManager(qr.manager, payload.tenantId, input, payload.createdBy),
    );
    return { created: true, taskId: saved.id, title: saved.title };
  }
}
