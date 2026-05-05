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
  Args,
  ID,
  ObjectType,
  Field,
  Int,
  Float,
} from '@nestjs/graphql';
import { Logger, UseGuards } from '@nestjs/common';
import { GqlAuthGuard } from '../../common/guards/gql-auth.guard';
import { CurrentTenant, CurrentUser } from '@aquaculture/backend-common/decorators';
import { StandardPaginatedResponse, IStandardPaginatedResult } from '@aquaculture/backend-common/pagination';
import { Task, TaskStatus } from '../entities/task.entity';
import { TaskService } from '../services/task.service';
import { CreateTaskInput } from '../dto/create-task.dto';
import { UpdateTaskInput } from '../dto/update-task.dto';
import { TaskFilterInput } from '../dto/task-filter.dto';

// ============================================================================
// USER CONTEXT
// ============================================================================

interface UserContext {
  sub: string;
  email: string;
  tenantId: string;
  roles: string[];
}

// ============================================================================
// RESPONSE TYPES
// ============================================================================

@ObjectType()
class TaskListResponse extends StandardPaginatedResponse(Task) {}

@ObjectType()
class TaskStatsResponse {
  @Field(() => Int)
  totalToday: number;

  @Field(() => Int)
  completedToday: number;

  @Field(() => Int)
  overdueCount: number;

  @Field(() => Int)
  upcomingCount: number;

  @Field(() => Float)
  completionRate: number;

  @Field(() => Float)
  avgCompletionMinutes: number;
}

// ============================================================================
// RESOLVER
// ============================================================================

@UseGuards(GqlAuthGuard)
@Resolver(() => Task)
export class TaskResolver {
  private readonly logger = new Logger(TaskResolver.name);

  constructor(private readonly taskService: TaskService) {}

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
    return this.taskService.findById(tenantId, id);
  }

  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => TaskListResponse, { name: 'tasks' })
  async getTasks(
    @CurrentTenant() tenantId: string,
    @Args('filter', { type: () => TaskFilterInput, nullable: true })
    filter?: TaskFilterInput,
  ): Promise<IStandardPaginatedResult<Task>> {
    this.logger.debug(`Listing tasks for tenant: ${tenantId}`);
    return this.taskService.findAll(tenantId, filter);
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
    return this.taskService.findByAssignee(tenantId, user.sub, status);
  }

  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => [Task], { name: 'todaysTasks' })
  async getTodaysTasks(
    @CurrentTenant() tenantId: string,
  ): Promise<Task[]> {
    this.logger.debug(`Getting today's tasks for tenant: ${tenantId}`);
    return this.taskService.findTodaysTasks(tenantId);
  }

  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => TaskStatsResponse, { name: 'taskStats' })
  async getTaskStats(
    @CurrentTenant() tenantId: string,
  ): Promise<TaskStatsResponse> {
    this.logger.debug(`Getting task stats for tenant: ${tenantId}`);
    return this.taskService.getStats(tenantId);
  }

  // -------------------------------------------------------------------------
  // MUTATIONS
  // -------------------------------------------------------------------------

  @Roles(Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN)
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
  @Mutation(() => Task)
  async updateTask(
    @Args('input') input: UpdateTaskInput,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: UserContext,
  ): Promise<Task> {
    this.logger.log(`Updating task: ${input.id}`);
    return this.taskService.update(tenantId, input, user.sub);
  }

  @Roles(Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN)
  @Mutation(() => Task)
  async completeTask(
    @Args('id', { type: () => ID }) id: string,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: UserContext,
  ): Promise<Task> {
    this.logger.log(`Completing task: ${id}`);
    return this.taskService.completeTask(tenantId, id, user.sub);
  }

  @Roles(Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN)
  @Mutation(() => Task)
  async startTask(
    @Args('id', { type: () => ID }) id: string,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: UserContext,
  ): Promise<Task> {
    this.logger.log(`Starting task: ${id}`);
    return this.taskService.startTask(tenantId, id, user.sub);
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

  @Roles(Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN)
  @Mutation(() => Task)
  async toggleChecklistItem(
    @Args('taskId', { type: () => ID }) taskId: string,
    @Args('itemId') itemId: string,
    @CurrentTenant() tenantId: string,
  ): Promise<Task> {
    this.logger.log(`Toggling checklist item ${itemId} on task ${taskId}`);
    return this.taskService.toggleChecklistItem(tenantId, taskId, itemId);
  }

  @Roles(Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN)
  @Mutation(() => Task)
  async addTaskNote(
    @Args('taskId', { type: () => ID }) taskId: string,
    @Args('text') text: string,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: UserContext,
  ): Promise<Task> {
    this.logger.log(`Adding note to task ${taskId}`);
    return this.taskService.addNote(tenantId, taskId, text, user.sub);
  }
}
