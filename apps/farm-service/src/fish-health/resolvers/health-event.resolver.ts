/**
 * HealthEvent Resolver
 *
 * GraphQL resolver for health event operations.
 * Exposes queries and mutations for fish health management.
 *
 * @module FishHealth
 */
import { Resolver, Query, Mutation, Args, ID, Int, ObjectType, Field, GraphQLISODateTime } from '@nestjs/graphql';
import { UseGuards, Logger } from '@nestjs/common';
import { CurrentTenant, CurrentUser, Role, Roles } from '@aquaculture/backend-common/decorators';
import { TenantGuard } from '@aquaculture/backend-common/guards';
import { StandardPaginatedResponse, IStandardPaginatedResult } from '@aquaculture/backend-common/pagination';
import GraphQLJSON from 'graphql-type-json';

import { HealthEvent, HealthEventStatus, TreatmentDetails } from '../entities/health-event.entity';
import { HealthEventService, HealthEventStats } from '../services/health-event.service';
import { BatchHarvestEligibilityService } from '../services/batch-harvest-eligibility.service';
import { CreateHealthEventInput } from '../dto/create-health-event.input';
import { UpdateHealthEventInput } from '../dto/update-health-event.input';
import { HealthEventFilterInput } from '../dto/health-event-filter.input';
import { TreatmentDetailsInput } from '../dto/create-health-event.input';
import { QueryBus } from '@platform/cqrs';
import { GetHealthEventQuery } from '../queries/get-health-event.query';
import { ListHealthEventsQuery } from '../queries/list-health-events.query';
import { ListHealthEventsByBatchQuery } from '../queries/list-health-events-by-batch.query';
import { ListCriticalHealthEventsQuery } from '../queries/list-critical-health-events.query';
import { ListOverdueFollowUpsQuery } from '../queries/list-overdue-follow-ups.query';
import { GetHealthEventStatsQuery } from '../queries/get-health-event-stats.query';

// ============================================================================
// RESPONSE TYPES
// ============================================================================

@ObjectType()
export class PaginatedHealthEventsResponse extends StandardPaginatedResponse(HealthEvent) {}

@ObjectType({
  description:
    'A single health event that currently blocks a batch from being harvested.',
})
export class BlockingHealthEventOutput {
  @Field(() => ID)
  id!: string;

  @Field()
  title!: string;

  @Field({ nullable: true })
  diseaseName?: string;

  @Field(() => GraphQLISODateTime)
  earliestHarvestDate!: Date;

  @Field(() => Int, { nullable: true })
  withdrawalPeriodDays?: number;

  @Field(() => HealthEventStatus)
  status!: HealthEventStatus;
}

@ObjectType({
  description:
    "Result of the 'can this batch be harvested on this date?' check. " +
    'When eligible is false, blockingEvents contains the active health ' +
    'events whose withdrawal period has not yet elapsed.',
})
export class HarvestEligibilityOutput {
  @Field()
  eligible!: boolean;

  @Field(() => GraphQLISODateTime, {
    nullable: true,
    description: 'Latest earliestHarvestDate among blocking events.',
  })
  blockedUntil?: Date;

  @Field({ nullable: true })
  reason?: string;

  @Field(() => [BlockingHealthEventOutput])
  blockingEvents!: BlockingHealthEventOutput[];
}

@ObjectType()
export class HealthEventStatsResponse {
  @Field(() => Int)
  total!: number;

  @Field(() => Int)
  active!: number;

  @Field(() => Int)
  critical!: number;

  @Field(() => Int)
  underTreatment!: number;

  @Field(() => Int)
  quarantined!: number;

  @Field(() => Int)
  resolved!: number;

  @Field(() => GraphQLJSON)
  byEventType!: Record<string, number>;

  @Field(() => GraphQLJSON)
  bySeverity!: Record<string, number>;
}

// ============================================================================
// RESOLVER
// ============================================================================

@Resolver(() => HealthEvent)
@UseGuards(TenantGuard)
export class HealthEventResolver {
  private readonly logger = new Logger(HealthEventResolver.name);

  constructor(
    private readonly healthEventService: HealthEventService,
    private readonly harvestEligibilityService: BatchHarvestEligibilityService,
    private readonly queryBus: QueryBus,
  ) {}

  // =========================================================================
  // QUERIES
  // =========================================================================

  /**
   * Get a single health event by ID
   */
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => HealthEvent, { nullable: true, description: 'Get health event by ID' })
  async healthEvent(
    @CurrentTenant() tenantId: string,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<HealthEvent | null> {
    return this.queryBus.execute(new GetHealthEventQuery(tenantId, id));
  }

  /**
   * List health events with filtering and pagination
   */
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => PaginatedHealthEventsResponse, { description: 'List health events with filters' })
  async healthEvents(
    @CurrentTenant() tenantId: string,
    @Args('filter', { nullable: true }) filter?: HealthEventFilterInput,
  ): Promise<IStandardPaginatedResult<HealthEvent>> {
    return this.queryBus.execute(new ListHealthEventsQuery(tenantId, filter));
  }

  /**
   * Get health events for a specific batch
   */
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => [HealthEvent], { description: 'Get health events for a batch' })
  async healthEventsByBatch(
    @CurrentTenant() tenantId: string,
    @Args('batchId', { type: () => ID }) batchId: string,
    @Args('activeOnly', { nullable: true, defaultValue: false }) activeOnly: boolean,
  ): Promise<HealthEvent[]> {
    return this.queryBus.execute(
      new ListHealthEventsByBatchQuery(tenantId, batchId, activeOnly),
    );
  }

  /**
   * Get critical health events (severe or critical severity, active status)
   */
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => [HealthEvent], { description: 'Get critical health events' })
  async criticalHealthEvents(
    @CurrentTenant() tenantId: string,
  ): Promise<HealthEvent[]> {
    return this.queryBus.execute(new ListCriticalHealthEventsQuery(tenantId));
  }

  /**
   * Get health events with overdue follow-ups
   */
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => [HealthEvent], { description: 'Get events with overdue follow-ups' })
  async overdueHealthFollowUps(
    @CurrentTenant() tenantId: string,
  ): Promise<HealthEvent[]> {
    return this.queryBus.execute(new ListOverdueFollowUpsQuery(tenantId));
  }

  /**
   * Get health event statistics
   */
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => HealthEventStatsResponse, { description: 'Get health event statistics' })
  async healthEventStats(
    @CurrentTenant() tenantId: string,
  ): Promise<HealthEventStats> {
    return this.queryBus.execute(new GetHealthEventStatsQuery(tenantId));
  }

  // =========================================================================
  // MUTATIONS - CRUD
  // =========================================================================

  /**
   * Create a new health event
   */
  @Roles(Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN)
  @Mutation(() => HealthEvent, { description: 'Create a new health event' })
  async createHealthEvent(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: { sub: string },
    @Args('input') input: CreateHealthEventInput,
  ): Promise<HealthEvent> {
    this.logger.log(`Creating health event for batch ${input.batchId}`);
    return this.healthEventService.create(tenantId, input, user.sub);
  }

  /**
   * Update an existing health event
   */
  @Roles(Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN)
  @Mutation(() => HealthEvent, { description: 'Update a health event' })
  async updateHealthEvent(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: { sub: string },
    @Args('id', { type: () => ID }) id: string,
    @Args('input') input: UpdateHealthEventInput,
  ): Promise<HealthEvent> {
    this.logger.log(`Updating health event ${id}`);
    return this.healthEventService.update(tenantId, id, input, user.sub);
  }

  /**
   * Delete a health event
   */
  @Roles(Role.TENANT_ADMIN)
  @Mutation(() => Boolean, { description: 'Delete a health event' })
  async deleteHealthEvent(
    @CurrentTenant() tenantId: string,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<boolean> {
    this.logger.log(`Deleting health event ${id}`);
    return this.healthEventService.delete(tenantId, id);
  }

  // =========================================================================
  // MUTATIONS - TREATMENT
  // =========================================================================

  /**
   * Start treatment for a health event
   */
  @Roles(Role.MODULE_MANAGER, Role.TENANT_ADMIN)
  @Mutation(() => HealthEvent, { description: 'Start treatment for a health event' })
  async startHealthEventTreatment(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: { sub: string },
    @Args('id', { type: () => ID }) id: string,
    @Args('treatment') treatment: TreatmentDetailsInput,
  ): Promise<HealthEvent> {
    this.logger.log(`Starting treatment for health event ${id}`);
    return this.healthEventService.startTreatment(tenantId, id, treatment as TreatmentDetails, user.sub);
  }

  /**
   * End treatment for a health event
   */
  @Roles(Role.MODULE_MANAGER, Role.TENANT_ADMIN)
  @Mutation(() => HealthEvent, { description: 'End treatment for a health event' })
  async endHealthEventTreatment(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: { sub: string },
    @Args('id', { type: () => ID }) id: string,
    @Args('notes', { nullable: true }) notes?: string,
  ): Promise<HealthEvent> {
    this.logger.log(`Ending treatment for health event ${id}`);
    return this.healthEventService.endTreatment(tenantId, id, notes, user.sub);
  }

  // =========================================================================
  // MUTATIONS - QUARANTINE
  // =========================================================================

  /**
   * Start quarantine for a health event
   */
  @Roles(Role.MODULE_MANAGER, Role.TENANT_ADMIN)
  @Mutation(() => HealthEvent, { description: 'Start quarantine for a health event' })
  async startHealthEventQuarantine(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: { sub: string },
    @Args('id', { type: () => ID }) id: string,
    @Args('quarantineTankId', { type: () => ID, nullable: true }) quarantineTankId?: string,
  ): Promise<HealthEvent> {
    this.logger.log(`Starting quarantine for health event ${id}`);
    return this.healthEventService.startQuarantine(tenantId, id, quarantineTankId, user.sub);
  }

  /**
   * End quarantine for a health event
   */
  @Roles(Role.MODULE_MANAGER, Role.TENANT_ADMIN)
  @Mutation(() => HealthEvent, { description: 'End quarantine for a health event' })
  async endHealthEventQuarantine(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: { sub: string },
    @Args('id', { type: () => ID }) id: string,
  ): Promise<HealthEvent> {
    this.logger.log(`Ending quarantine for health event ${id}`);
    return this.healthEventService.endQuarantine(tenantId, id, user.sub);
  }

  // =========================================================================
  // MUTATIONS - RESOLUTION
  // =========================================================================

  /**
   * Resolve a health event
   */
  @Roles(Role.MODULE_MANAGER, Role.TENANT_ADMIN)
  @Mutation(() => HealthEvent, { description: 'Resolve a health event' })
  async resolveHealthEvent(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: { sub: string },
    @Args('id', { type: () => ID }) id: string,
    @Args('notes', { nullable: true }) notes?: string,
  ): Promise<HealthEvent> {
    this.logger.log(`Resolving health event ${id}`);
    return this.healthEventService.resolve(tenantId, id, notes, user.sub);
  }

  // =========================================================================
  // HARVEST ELIGIBILITY (compliance / withdrawal period)
  // =========================================================================

  /**
   * Pre-submit check for the harvest form: returns eligible=false when
   * any active health event on the batch has an earliestHarvestDate
   * beyond the requested harvest date. The UI should disable the
   * harvest submit button and display the blockingEvents list so the
   * operator can see exactly why the harvest is blocked.
   *
   * The same rule is also enforced server-side inside the
   * createHarvestRecord command handler — this query just surfaces the
   * decision to the UI early.
   */
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => HarvestEligibilityOutput, {
    description:
      "Check whether a batch can be harvested on the given date " +
      'without violating an active medicine withdrawal period.',
  })
  async batchHarvestEligibility(
    @CurrentTenant() tenantId: string,
    @Args('batchId', { type: () => ID }) batchId: string,
    @Args('harvestDate', { type: () => GraphQLISODateTime }) harvestDate: Date,
  ): Promise<HarvestEligibilityOutput> {
    const result = await this.harvestEligibilityService.checkEligibility(
      tenantId,
      batchId,
      harvestDate,
    );
    return {
      eligible: result.eligible,
      blockedUntil: result.blockedUntil,
      reason: result.reason,
      blockingEvents: result.blockingEvents.map((e) => ({
        id: e.id,
        title: e.title,
        diseaseName: e.diseaseName ?? undefined,
        earliestHarvestDate: e.earliestHarvestDate,
        withdrawalPeriodDays: e.withdrawalPeriodDays ?? undefined,
        status: e.status,
      })),
    };
  }
}
