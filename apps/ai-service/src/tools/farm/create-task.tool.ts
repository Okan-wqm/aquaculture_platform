import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom, timeout } from 'rxjs';
import { BaseTool } from '../core/base-tool';
import { Tool } from '../core/tool.decorator';
import { ToolExecutionContext } from '../core/tool.interface';

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

interface CreateTaskNatsResponse {
  ok: boolean;
  taskId?: string;
  title?: string;
  error?: string;
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
  requiresModule: null,
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
  // Typed to the single method the tool uses (DI resolves by the 'NATS_SERVICE'
  // token, not the parameter type) — the narrow surface keeps the collaborator
  // trivially mockable without a cast.
  constructor(
    @Inject('NATS_SERVICE') private readonly natsClient: Pick<ClientProxy, 'send'>,
  ) {
    super();
  }

  protected async run(
    input: CreateTaskToolInput,
    ctx: ToolExecutionContext,
  ): Promise<CreateTaskToolOutput> {
    const response = await firstValueFrom(
      this.natsClient
        .send<CreateTaskNatsResponse>('request.farm.createTask', {
          tenantId: ctx.tenantId,
          createdBy: ctx.userId,
          // Self-assign: no safe cross-user targeting from the chat path.
          assignedTo: ctx.userId,
          assignedToName: 'AI ile oluşturuldu',
          title: input.title,
          description: input.description,
          category: input.category,
          priority: input.priority,
          dueDate: input.dueDate,
        })
        .pipe(timeout(CREATE_TASK_TIMEOUT_MS)),
    );

    if (!response?.ok || !response.taskId) {
      throw new Error(response?.error ?? 'Task could not be created');
    }

    return { taskId: response.taskId, title: response.title ?? input.title, assignedToSelf: true };
  }
}
