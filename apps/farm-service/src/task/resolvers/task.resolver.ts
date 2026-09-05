/**
 * Task GraphQL Resolver
 *
 * Görev CRUD operasyonları ve durum yönetimi için GraphQL API.
 *
 * @module Task/Resolvers
 */
import {
  Resolver,
  Query,
  Mutation,
  ResolveField,
  Parent,
  Args,
  ID,
  ObjectType,
  Field,
  Int,
  Float,
} from '@nestjs/graphql';
import { Logger, UseGuards } from '@nestjs/common';
import { GqlAuthGuard } from '../../common/guards/gql-auth.guard';
import { CurrentTenant, CurrentUser, Role, Roles, RequiresMobileFeature } from '@aquaculture/backend-common/decorators';
import { MobileFeatureGuard } from '@aquaculture/backend-common/guards';
import { mobileCommandEnvelopeFromInput } from '@aquaculture/backend-common/mobile-command';
import { StandardPaginatedResponse, IStandardPaginatedResult } from '@aquaculture/backend-common/pagination';
import { QueryBus } from '@platform/cqrs';
import { Task, TaskChecklistItem, TaskStatus } from '../entities/task.entity';
import { TaskService } from '../services/task.service';
import { GetTaskQuery } from '../queries/get-task.query';
import { ListTasksQuery } from '../queries/list-tasks.query';
import { ListMyTasksQuery } from '../queries/list-my-tasks.query';
import { ListTodaysTasksQuery } from '../queries/list-todays-tasks.query';
import { GetTaskStatsQuery } from '../queries/get-task-stats.query';
import { CreateTaskInput } from '../dto/create-task.dto';
import {
  UpdateTaskInput,
  TaskLifecycleInput,
  SetChecklistItemInput,
} from '../dto/update-task.dto';
import { TaskFilterInput } from '../dto/task-filter.dto';

// ============================================================================
// USER CONTEXT
// ============================================================================

/**
 * WHY: roles typed as Role[] (the canonical backend enum) because the JWT guard
 * validates enum membership before the request reaches the resolver. This is the
 * single typed boundary where the JWT-supplied role strings become canonical
 * Role values — fed into the SEC-HIGH-050 object-level self-scope assertion.
 */
interface UserContext {
  sub: string;
  email: string;
  tenantId: string;
  roles: Role[];
}

// ============================================================================
// RESPONSE TYPES
// ============================================================================

@ObjectType()
class TaskListResponse extends StandardPaginatedResponse(Task) {}

@ObjectType()
class TaskStatsResponse {
  @Field(() => Int)
  totalToday!: number;

  @Field(() => Int)
  completedToday!: number;

  @Field(() => Int)
  overdueCount!: number;

  @Field(() => Int)
  upcomingCount!: number;

  @Field(() => Float)
  completionRate!: number;

  @Field(() => Float)
  avgCompletionMinutes!: number;
}

// ============================================================================
// RESOLVER
// ============================================================================

// SEC-HIGH-052: MobileFeatureGuard enforces the 'tasks' mobile entitlement on
// the field-worker task mutations below (no-op on queries / un-annotated routes).
@UseGuards(GqlAuthGuard, MobileFeatureGuard)
@Resolver(() => Task)
export class TaskResolver {
  private readonly logger = new Logger(TaskResolver.name);

  constructor(
    private readonly taskService: TaskService,
    private readonly queryBus: QueryBus,
  ) {}

  // -------------------------------------------------------------------------
  // FIELD RESOLVERS
  // -------------------------------------------------------------------------

  /**
   * The wire `checklistItems` is the CANONICAL shape, never the stored one
   * (FARM-HIGH-318): every row passes through the same normaliser the write
   * path uses, so a legacy `{ text, completed }` item reads as
   * `{ id, text, isCompleted }` instead of an unticked, id-less object each
   * client has to repair for itself.
   */
  @ResolveField(() => [TaskChecklistItem], { name: 'checklistItems' })
  checklistItems(@Parent() task: Task): TaskChecklistItem[] {
    return TaskService.normaliseChecklistItems(task.checklistItems);
  }

  // -------------------------------------------------------------------------
  // QUERIES
  // -------------------------------------------------------------------------

  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => Task, { name: 'task' })
  async getTask(
    @Args('id', { type: () => ID }) id: string,
    @CurrentTenant() tenantId: string,
  ): Promise<Task> {
    this.logger.debug(`Getting task: ${id}`);
    return this.queryBus.execute(new GetTaskQuery(tenantId, id));
  }

  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => TaskListResponse, { name: 'tasks' })
  async getTasks(
    @CurrentTenant() tenantId: string,
    @Args('filter', { type: () => TaskFilterInput, nullable: true })
    filter?: TaskFilterInput,
  ): Promise<IStandardPaginatedResult<Task>> {
    this.logger.debug(`Listing tasks for tenant: ${tenantId}`);
    return this.queryBus.execute(new ListTasksQuery(tenantId, filter));
  }

  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => [Task], { name: 'myTasks' })
  async getMyTasks(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: UserContext,
    @Args('status', { type: () => [TaskStatus], nullable: true })
    status?: TaskStatus[],
  ): Promise<Task[]> {
    this.logger.debug(`Getting tasks for user: ${user.sub}`);
    return this.queryBus.execute(new ListMyTasksQuery(tenantId, user.sub, status));
  }

  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => [Task], { name: 'todaysTasks' })
  async getTodaysTasks(
    @CurrentTenant() tenantId: string,
  ): Promise<Task[]> {
    this.logger.debug(`Getting today's tasks for tenant: ${tenantId}`);
    return this.queryBus.execute(new ListTodaysTasksQuery(tenantId));
  }

  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => TaskStatsResponse, { name: 'taskStats' })
  async getTaskStats(
    @CurrentTenant() tenantId: string,
  ): Promise<TaskStatsResponse> {
    this.logger.debug(`Getting task stats for tenant: ${tenantId}`);
    return this.queryBus.execute(new GetTaskStatsQuery(tenantId));
  }

  // -------------------------------------------------------------------------
  // MUTATIONS
  // -------------------------------------------------------------------------

  @Roles(Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN)
  @RequiresMobileFeature('tasks')
  @Mutation(() => Task)
  async createTask(
    @Args('input') input: CreateTaskInput,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: UserContext,
  ): Promise<Task> {
    this.logger.log(`Creating task: ${input.title}`);
    return this.taskService.create(tenantId, input, user.sub);
  }

  @Roles(Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN)
  @RequiresMobileFeature('tasks')
  @Mutation(() => Task)
  async updateTask(
    @Args('input') input: UpdateTaskInput,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: UserContext,
  ): Promise<Task> {
    this.logger.log(`Updating task: ${input.id}`);
    return this.taskService.update(tenantId, input, {
      sub: user.sub,
      roles: user.roles,
    });
  }

  @Roles(Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN)
  @RequiresMobileFeature('tasks')
  @Mutation(() => Task)
  async completeTask(
    @Args('input') input: TaskLifecycleInput,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: UserContext,
  ): Promise<Task> {
    this.logger.log(`Completing task: ${input.id}`);
    return this.taskService.completeTask(
      tenantId,
      input.id,
      { sub: user.sub, roles: user.roles },
      mobileCommandEnvelopeFromInput(input),
    );
  }

  @Roles(Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN)
  @RequiresMobileFeature('tasks')
  @Mutation(() => Task)
  async startTask(
    @Args('input') input: TaskLifecycleInput,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: UserContext,
  ): Promise<Task> {
    this.logger.log(`Starting task: ${input.id}`);
    return this.taskService.startTask(
      tenantId,
      input.id,
      { sub: user.sub, roles: user.roles },
      mobileCommandEnvelopeFromInput(input),
    );
  }

  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  @Mutation(() => Boolean)
  async deleteTask(
    @Args('id', { type: () => ID }) id: string,
    @CurrentTenant() tenantId: string,
  ): Promise<boolean> {
    this.logger.log(`Deleting task: ${id}`);
    return this.taskService.delete(tenantId, id);
  }

  /**
   * FARM-HIGH-057 BREAKING CHANGE: `toggleChecklistItem` (a blind flip) is
   * replaced by `setChecklistItem`, which carries the ABSOLUTE target
   * `isCompleted` plus the idempotency envelope so offline replays converge
   * instead of reverting the item.
   */
  @Roles(Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN)
  @RequiresMobileFeature('tasks')
  @Mutation(() => Task)
  async setChecklistItem(
    @Args('input') input: SetChecklistItemInput,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: UserContext,
  ): Promise<Task> {
    this.logger.log(`Setting checklist item ${input.itemId} on task ${input.taskId}`);
    return this.taskService.setChecklistItem(
      tenantId,
      input.taskId,
      input.itemId,
      input.isCompleted,
      { sub: user.sub, roles: user.roles },
      mobileCommandEnvelopeFromInput(input),
    );
  }

  @Roles(Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN)
  @RequiresMobileFeature('tasks')
  @Mutation(() => Task)
  async addTaskNote(
    @Args('taskId', { type: () => ID }) taskId: string,
    @Args('text') text: string,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: UserContext,
  ): Promise<Task> {
    this.logger.log(`Adding note to task ${taskId}`);
    return this.taskService.addNote(tenantId, taskId, text, {
      sub: user.sub,
      roles: user.roles,
    });
  }
}
