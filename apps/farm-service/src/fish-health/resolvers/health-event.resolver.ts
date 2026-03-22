/**
 * HealthEvent Resolver
 *
 * GraphQL resolver for health event operations.
 * Exposes queries and mutations for fish health management.
 *
 * @module FishHealth
 */
import { Resolver, Query, Mutation, Args, ID, Int, ObjectType, Field } from '@nestjs/graphql';
import { UseGuards, Logger } from '@nestjs/common';
import { TenantGuard, CurrentTenant, CurrentUser, StandardPaginatedResponse, IStandardPaginatedResult } from '@aquaculture/backend-common';
import GraphQLJSON from 'graphql-type-json';

import { HealthEvent } from '../entities/health-event.entity';
import { HealthEventService, HealthEventStats } from '../services/health-event.service';
import { CreateHealthEventInput } from '../dto/create-health-event.input';
import { UpdateHealthEventInput } from '../dto/update-health-event.input';
import { HealthEventFilterInput } from '../dto/health-event-filter.input';
import { TreatmentDetailsInput } from '../dto/create-health-event.input';

// ============================================================================
// RESPONSE TYPES
// ============================================================================

@ObjectType()
export class PaginatedHealthEventsResponse extends StandardPaginatedResponse(HealthEvent) {}

@ObjectType()
export class HealthEventStatsResponse {
  @Field(() => Int)
  total: number;

  @Field(() => Int)
  active: number;

  @Field(() => Int)
  critical: number;

  @Field(() => Int)
  underTreatment: number;

  @Field(() => Int)
  quarantined: number;

  @Field(() => Int)
  resolved: number;

  @Field(() => GraphQLJSON)
  byEventType: Record<string, number>;

  @Field(() => GraphQLJSON)
  bySeverity: Record<string, number>;
}

// ============================================================================
// RESOLVER
// ============================================================================

@Resolver(() => HealthEvent)
@UseGuards(TenantGuard)
export class HealthEventResolver {
  private readonly logger = new Logger(HealthEventResolver.name);

  constructor(private readonly healthEventService: HealthEventService) {}

  // =========================================================================
  // QUERIES
  // =========================================================================

  /**
   * Get a single health event by ID
   */
  @Query(() => HealthEvent, { nullable: true, description: 'Get health event by ID' })
  async healthEvent(
    @CurrentTenant() tenantId: string,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<HealthEvent | null> {
    return this.healthEventService.findById(tenantId, id);
  }

  /**
   * List health events with filtering and pagination
   */
  @Query(() => PaginatedHealthEventsResponse, { description: 'List health events with filters' })
  async healthEvents(
    @CurrentTenant() tenantId: string,
    @Args('filter', { nullable: true }) filter?: HealthEventFilterInput,
  ): Promise<IStandardPaginatedResult<HealthEvent>> {
    return this.healthEventService.findAll(tenantId, filter);
  }

  /**
   * Get health events for a specific batch
   */
  @Query(() => [HealthEvent], { description: 'Get health events for a batch' })
  async healthEventsByBatch(
    @CurrentTenant() tenantId: string,
    @Args('batchId', { type: () => ID }) batchId: string,
    @Args('activeOnly', { nullable: true, defaultValue: false }) activeOnly: boolean,
  ): Promise<HealthEvent[]> {
    return this.healthEventService.findByBatch(tenantId, batchId, activeOnly);
  }

  /**
   * Get critical health events (severe or critical severity, active status)
   */
  @Query(() => [HealthEvent], { description: 'Get critical health events' })
  async criticalHealthEvents(
    @CurrentTenant() tenantId: string,
  ): Promise<HealthEvent[]> {
    return this.healthEventService.findCritical(tenantId);
  }

  /**
   * Get health events with overdue follow-ups
   */
  @Query(() => [HealthEvent], { description: 'Get events with overdue follow-ups' })
  async overdueHealthFollowUps(
    @CurrentTenant() tenantId: string,
  ): Promise<HealthEvent[]> {
    return this.healthEventService.findOverdueFollowUps(tenantId);
  }

  /**
   * Get health event statistics
   */
  @Query(() => HealthEventStatsResponse, { description: 'Get health event statistics' })
  async healthEventStats(
    @CurrentTenant() tenantId: string,
  ): Promise<HealthEventStats> {
    return this.healthEventService.getStats(tenantId);
  }

  // =========================================================================
  // MUTATIONS - CRUD
  // =========================================================================

  /**
   * Create a new health event
   */
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
  @Mutation(() => HealthEvent, { description: 'Start treatment for a health event' })
  async startHealthEventTreatment(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: { sub: string },
    @Args('id', { type: () => ID }) id: string,
    @Args('treatment') treatment: TreatmentDetailsInput,
  ): Promise<HealthEvent> {
    this.logger.log(`Starting treatment for health event ${id}`);
    return this.healthEventService.startTreatment(tenantId, id, treatment as any, user.sub);
  }

  /**
   * End treatment for a health event
   */
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
}
