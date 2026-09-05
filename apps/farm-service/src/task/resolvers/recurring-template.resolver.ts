/**
 * RecurringTemplate GraphQL Resolver
 *
 * Tekrarlayan görev şablonu CRUD operasyonları için GraphQL API.
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
  InputType,
  Field,
  Int,
} from '@nestjs/graphql';
import { Logger, UseGuards } from '@nestjs/common';
import {
  IsNotEmpty,
  IsString,
  IsOptional,
  IsEnum,
  IsUUID,
  IsNumber,
  IsArray,
  Min,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { GqlAuthGuard } from '../../common/guards/gql-auth.guard';
import { CurrentTenant, CurrentUser, Role, Roles } from '@aquaculture/backend-common/decorators';
import { RecurringTemplate, RecurrenceFrequency } from '../entities/recurring-template.entity';
import { TaskCategory, TaskChecklistItem, TaskPriority } from '../entities/task.entity';
import { TaskChecklistItemInput } from '../dto/create-task.dto';
import { TaskService } from '../services/task.service';
import { QueryBus } from '@platform/cqrs';
import { RecurringTaskService } from '../services/recurring-task.service';
import { ListRecurringTemplatesQuery } from '../queries/list-recurring-templates.query';
import { GetRecurringTemplateQuery } from '../queries/get-recurring-template.query';

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
// INPUT TYPES
// ============================================================================

@InputType()
class CreateRecurringTemplateInput {
  @Field()
  @IsNotEmpty()
  @IsString()
  @MaxLength(255)
  title!: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  description?: string;

  @Field(() => TaskCategory)
  @IsNotEmpty()
  @IsEnum(TaskCategory)
  category!: TaskCategory;

  @Field(() => TaskPriority)
  @IsNotEmpty()
  @IsEnum(TaskPriority)
  priority!: TaskPriority;

  @Field(() => RecurrenceFrequency)
  @IsNotEmpty()
  @IsEnum(RecurrenceFrequency)
  frequency!: RecurrenceFrequency;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  frequencyDetail?: string;

  @Field(() => ID)
  @IsNotEmpty()
  @IsUUID()
  assignedTo!: string;

  @Field()
  @IsNotEmpty()
  @IsString()
  assignedToName!: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  location?: string;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(1)
  estimatedMinutes?: number;

  @Field(() => [TaskChecklistItemInput], { nullable: true })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => TaskChecklistItemInput)
  checklistItems?: TaskChecklistItemInput[];

  @Field(() => [String], { nullable: true })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];
}

@InputType()
class UpdateRecurringTemplateInput {
  @Field(() => ID)
  @IsNotEmpty()
  @IsUUID()
  id!: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  title?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  description?: string;

  @Field(() => TaskCategory, { nullable: true })
  @IsOptional()
  @IsEnum(TaskCategory)
  category?: TaskCategory;

  @Field(() => TaskPriority, { nullable: true })
  @IsOptional()
  @IsEnum(TaskPriority)
  priority?: TaskPriority;

  @Field(() => RecurrenceFrequency, { nullable: true })
  @IsOptional()
  @IsEnum(RecurrenceFrequency)
  frequency?: RecurrenceFrequency;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  frequencyDetail?: string;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  assignedTo?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  assignedToName?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  location?: string;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(1)
  estimatedMinutes?: number;

  @Field(() => [TaskChecklistItemInput], { nullable: true })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => TaskChecklistItemInput)
  checklistItems?: TaskChecklistItemInput[];

  @Field(() => [String], { nullable: true })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];
}

// ============================================================================
// RESOLVER
// ============================================================================

@UseGuards(GqlAuthGuard)
@Resolver(() => RecurringTemplate)
export class RecurringTemplateResolver {
  private readonly logger = new Logger(RecurringTemplateResolver.name);

  constructor(
    private readonly recurringTaskService: RecurringTaskService,
    private readonly queryBus: QueryBus,
  ) {}

  // -------------------------------------------------------------------------
  // FIELD RESOLVERS
  // -------------------------------------------------------------------------

  /** Same canonical read path as TaskResolver.checklistItems (FARM-HIGH-318). */
  @ResolveField(() => [TaskChecklistItem], { name: 'checklistItems' })
  checklistItems(@Parent() template: RecurringTemplate): TaskChecklistItem[] {
    return TaskService.normaliseChecklistItems(template.checklistItems);
  }

  // -------------------------------------------------------------------------
  // QUERIES
  // -------------------------------------------------------------------------

  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => [RecurringTemplate], { name: 'recurringTemplates' })
  async getRecurringTemplates(
    @CurrentTenant() tenantId: string,
  ): Promise<RecurringTemplate[]> {
    this.logger.debug(`Listing recurring templates for tenant: ${tenantId}`);
    return this.queryBus.execute(new ListRecurringTemplatesQuery(tenantId));
  }

  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => RecurringTemplate, { name: 'recurringTemplate' })
  async getRecurringTemplate(
    @Args('id', { type: () => ID }) id: string,
    @CurrentTenant() tenantId: string,
  ): Promise<RecurringTemplate> {
    this.logger.debug(`Getting recurring template: ${id}`);
    return this.queryBus.execute(new GetRecurringTemplateQuery(tenantId, id));
  }

  // -------------------------------------------------------------------------
  // MUTATIONS
  // -------------------------------------------------------------------------

  @Roles(Role.MODULE_MANAGER, Role.TENANT_ADMIN)
  @Mutation(() => RecurringTemplate)
  async createRecurringTemplate(
    @Args('input') input: CreateRecurringTemplateInput,
    @CurrentTenant() tenantId: string,
  ): Promise<RecurringTemplate> {
    this.logger.log(`Creating recurring template: ${input.title}`);
    return this.recurringTaskService.create(tenantId, input);
  }

  @Roles(Role.MODULE_MANAGER, Role.TENANT_ADMIN)
  @Mutation(() => RecurringTemplate)
  async updateRecurringTemplate(
    @Args('input') input: UpdateRecurringTemplateInput,
    @CurrentTenant() tenantId: string,
  ): Promise<RecurringTemplate> {
    this.logger.log(`Updating recurring template: ${input.id}`);
    const { id, ...data } = input;
    return this.recurringTaskService.update(tenantId, id, data);
  }

  @Roles(Role.TENANT_ADMIN)
  @Mutation(() => Boolean)
  async deleteRecurringTemplate(
    @Args('id', { type: () => ID }) id: string,
    @CurrentTenant() tenantId: string,
  ): Promise<boolean> {
    this.logger.log(`Deleting recurring template: ${id}`);
    return this.recurringTaskService.delete(tenantId, id);
  }

  @Roles(Role.MODULE_MANAGER, Role.TENANT_ADMIN)
  @Mutation(() => RecurringTemplate)
  async toggleRecurringTemplateActive(
    @Args('id', { type: () => ID }) id: string,
    @CurrentTenant() tenantId: string,
  ): Promise<RecurringTemplate> {
    this.logger.log(`Toggling recurring template active: ${id}`);
    return this.recurringTaskService.toggleActive(tenantId, id);
  }
}
