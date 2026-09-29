import { Injectable } from '@nestjs/common';
import { TenantBoundNatsClient } from '../../tenant-boundary/tenant-bound-nats.client';
import { BaseTool } from '../core/base-tool';
import { Tool } from '../core/tool.decorator';
import { TenantBoundToolContext } from '../core/tool.interface';

/** Bound so a hung farm-service cannot stall the agent turn. */
const CREATE_TASK_TIMEOUT_MS = 5000;

interface CreateTaskToolInput {
  title: string;
  description?: string;
  category: string;
  priority: string;
  dueDate: string;
}

interface CreateTaskToolOutput {
  taskId: string;
  title: string;
  assignedToSelf: true;
}

/**
 * Domain outcome from farm-service (inside the tenant-bound envelope, K10):
 * a rejection is data the model relays, a transport failure is the
 * envelope's error.
 */
type CreateTaskOutcome =
  | { created: true; taskId: string; title: string }
  | { created: false; reason: string };

function isCreateTaskOutcome(value: unknown): value is CreateTaskOutcome {
  if (typeof value !== 'object' || value === null || !('created' in value)) return false;
  if (value.created === true) {
    return (
      'taskId' in value &&
      typeof value.taskId === 'string' &&
      'title' in value &&
      typeof value.title === 'string'
    );
  }
  return value.created === false && 'reason' in value && typeof value.reason === 'string';
}

/**
 * Create a farm task on behalf of the requesting user. This is an ACTUATION
 * tool (requiresConfirmation) — the executor runs it autonomously only under an
 * 'allowed' actuation policy; otherwise it surfaces for confirmation. The write
 * crosses to farm-service via request.farm.createTask (no HTTP hop, no direct
 * cross-schema DB access); farm-service owns validation + the outbox event.
 *
 * The task is self-assigned (assignedTo = the requesting user) because the AI
 * chat path carries no directory of tenant users to safely target someone else;
 * a human can reassign it from the task board.
 */
@Injectable()
@Tool({
  name: 'create_task',
  description:
    'Create a farm task assigned to the current user. Use for follow-ups the ' +
    'operator asks to remember (e.g. "remind me to check pond 3 tomorrow"). ' +
    'Requires confirmation before it runs.',
  category: 'actuation',
  runtime: 'cloud',
  requiredPermissions: ['operator', 'manager', 'expert', 'supervisor'],
  requiresModule: 'farm',
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Short, action-oriented task title' },
      description: { type: 'string', description: 'Optional additional detail' },
      category: {
        type: 'string',
        enum: [
          'FEEDING',
          'WATER_QUALITY',
          'HEALTH_CHECK',
          'EQUIPMENT_MAINTENANCE',
          'STOCK_MANAGEMENT',
          'CLEANING',
          'REGULATORY',
          'HARVEST',
          'ENVIRONMENTAL',
          'SAFETY',
          'GENERAL',
        ],
        description: 'Task category; use GENERAL if none fits',
      },
      priority: {
        type: 'string',
        enum: ['URGENT', 'HIGH', 'MEDIUM', 'LOW'],
        description: 'Task priority',
      },
      dueDate: {
        type: 'string',
        description: 'Due date in ISO-8601 (e.g. 2026-07-10 or 2026-07-10T09:00:00Z)',
      },
    },
    required: ['title', 'category', 'priority', 'dueDate'],
  },
  requiresConfirmation: true,
})
export class CreateTaskTool extends BaseTool<CreateTaskToolInput, CreateTaskToolOutput> {
  constructor(private readonly farm: TenantBoundNatsClient) {
    super();
  }

  protected async run(
    input: CreateTaskToolInput,
    ctx: TenantBoundToolContext,
  ): Promise<CreateTaskToolOutput> {
    // K10 (MT-HIGH-062): the task is written in ctx's bound tenant — the
    // client injects it — and the reply must name that tenant.
    const outcome = await this.farm.request(ctx, {
      subject: 'request.farm.createTask',
      fields: {
        createdBy: ctx.userId,
        // Self-assign: no safe cross-user targeting from the chat path.
        assignedTo: ctx.userId,
        assignedToName: 'AI ile oluşturuldu',
        title: input.title,
        description: input.description,
        category: input.category,
        priority: input.priority,
        dueDate: input.dueDate,
      },
      isData: isCreateTaskOutcome,
      timeoutMs: CREATE_TASK_TIMEOUT_MS,
    });

    if (!outcome.created) {
      throw new Error(outcome.reason);
    }

    return { taskId: outcome.taskId, title: outcome.title, assignedToSelf: true };
  }
}
