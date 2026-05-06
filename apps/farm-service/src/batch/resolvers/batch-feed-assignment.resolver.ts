/**
 * Batch Feed Assignment Resolver
 *
 * GraphQL mutations and queries for managing feed assignments to batches.
 * Allows assigning different feeds based on fish weight ranges.
 *
 * # Architecture — TypeORM repository pattern (FARM-MEDIUM-003 closure)
 *
 * Pre-refactor this resolver bypassed TypeORM with raw SQL via
 * `getTenantSchemaName(tenantId)` interpolation against
 * `${schema}.batch_feed_assignments`. Empirical investigation
 * (FARM-MEDIUM-003 finding notes) confirmed both paths land on the
 * same physical table — per-tenant schema cloning is canonical
 * (`MODULE_SCHEMAS[farm].sourceSchema = 'farm', tables: ['batch_feed_
 * assignments', ...]` + `CREATE TABLE LIKE INCLUDING ALL` per-tenant
 * provisioning) and `TenantConnectionBootstrap` sets per-request
 * search_path to the tenant schema, so unqualified TypeORM-emitted
 * `batch_feed_assignments` resolves to the same `tenant_<id>` copy
 * the raw SQL targeted explicitly.
 *
 * Converging on TypeORM repos rather than raw SQL gives:
 *   1. Type-safe column/relation access (catches a removed column at
 *      build time instead of at runtime).
 *   2. Uniformity with every other farm-service handler (the rest
 *      of the codebase uses repos; this resolver was the lone
 *      raw-SQL outlier).
 *   3. Compatibility with `RestoreService.restore()` — which uses
 *      repository.find / save and is the canonical route for the
 *      uniform restore-mutation surface from PR-47 (FARM-MEDIUM-002).
 *      `restoreBatchFeedAssignment` could not exist on the raw-SQL
 *      side without duplicating the uniqueness-check logic from
 *      RestoreService.
 *
 * Validation paths (Batch + Feed existence checks) likewise routed
 * through `batchRepo.findOne` / `feedRepo.findOne` rather than raw
 * `batches_v2` / `feeds` queries.
 */
import { Resolver, Query, Mutation, Args, ID } from '@nestjs/graphql';
import { UseGuards, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CurrentTenant, CurrentUser, Roles, Role } from '@aquaculture/backend-common/decorators';
import { TenantGuard } from '@aquaculture/backend-common/guards';
import { BatchFeedAssignment, FeedAssignmentEntry } from '../entities/batch-feed-assignment.entity';
import { Batch } from '../entities/batch.entity';
import { Feed } from '../../feed/entities/feed.entity';
import { BatchFeedAssignmentResponse } from '../dto/batch-feed-assignment.response';
import { AssignFeedsToBatchInput, UpdateBatchFeedAssignmentInput } from '../dto/batch-feed-assignment.input';
import { RestoreService } from '../../common/services/restore.service';

@Resolver(() => BatchFeedAssignmentResponse)
@UseGuards(TenantGuard)
export class BatchFeedAssignmentResolver {
  private readonly logger = new Logger(BatchFeedAssignmentResolver.name);

  constructor(
    @InjectRepository(BatchFeedAssignment)
    private readonly feedAssignmentRepo: Repository<BatchFeedAssignment>,
    @InjectRepository(Batch)
    private readonly batchRepo: Repository<Batch>,
    @InjectRepository(Feed)
    private readonly feedRepo: Repository<Feed>,
    private readonly restoreService: RestoreService,
  ) {}

  /**
   * Get feed assignment for a batch
   */
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => BatchFeedAssignmentResponse, { nullable: true })
  async batchFeedAssignment(
    @Args('batchId', { type: () => ID }) batchId: string,
    @CurrentTenant() tenantId: string,
  ): Promise<BatchFeedAssignmentResponse | null> {
    const assignment = await this.feedAssignmentRepo.findOne({
      where: { tenantId, batchId, isDeleted: false },
    });
    if (!assignment) return null;
    return this.mapToResponse(assignment);
  }

  /**
   * Assign feeds to a batch with weight ranges. Creates new or
   * updates existing assignment (upsert by `(tenantId, batchId)` —
   * the entity's UNIQUE index forbids two active rows for the same
   * batch).
   */
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  @Mutation(() => BatchFeedAssignmentResponse)
  async assignFeedsToBatch(
    @Args('input') input: AssignFeedsToBatchInput,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: { sub: string },
  ): Promise<BatchFeedAssignmentResponse> {
    this.logger.log(`Assigning feeds to batch ${input.batchId} for tenant ${tenantId}`);

    // Validate the batch exists. tenantId in the WHERE keeps the
    // lookup tenant-scoped even if the search_path mechanism ever
    // changes — defence in depth.
    const batch = await this.batchRepo.findOne({
      where: { id: input.batchId, tenantId, isDeleted: false },
    });
    if (!batch) {
      throw new NotFoundException(`Batch ${input.batchId} not found`);
    }

    // Validate every referenced feed exists. The loop is small (an
    // assignment usually has 3-5 entries — starter / grower /
    // finisher), so per-feed findOne is fine.
    for (const entry of input.feedAssignments) {
      const feed = await this.feedRepo.findOne({
        where: { id: entry.feedId, tenantId, isDeleted: false },
      });
      if (!feed) {
        throw new NotFoundException(`Feed ${entry.feedId} not found`);
      }
    }

    const feedAssignments: FeedAssignmentEntry[] = input.feedAssignments.map(
      (entry, index) => ({
        feedId: entry.feedId,
        feedCode: entry.feedCode,
        feedName: entry.feedName,
        minWeightG: entry.minWeightG,
        maxWeightG: entry.maxWeightG,
        priority: entry.priority ?? index + 1,
      }),
    );

    // Upsert: load existing active row, update if present, else
    // create. The entity's `@Index(['tenantId','batchId'], { unique:
    // true })` enforces single-active-assignment-per-batch at the
    // DB layer; this lookup is the operator-friendly path.
    const existing = await this.feedAssignmentRepo.findOne({
      where: { tenantId, batchId: input.batchId, isDeleted: false },
    });

    let assignment: BatchFeedAssignment;
    if (existing) {
      existing.feedAssignments = feedAssignments;
      existing.notes = input.notes;
      existing.updatedBy = user.sub;
      // updatedAt + version are managed by TypeORM via the
      // @UpdateDateColumn + @VersionColumn decorators.
      assignment = await this.feedAssignmentRepo.save(existing);
    } else {
      const draft = this.feedAssignmentRepo.create({
        tenantId,
        batchId: input.batchId,
        feedAssignments,
        notes: input.notes,
        isActive: true,
        isDeleted: false,
        createdBy: user.sub,
      });
      assignment = await this.feedAssignmentRepo.save(draft);
    }

    return this.mapToResponse(assignment);
  }

  /**
   * Update feed assignment — partial update of a specific assignment
   * row. Differs from `assignFeedsToBatch` which is an upsert keyed
   * by batchId; this targets a specific assignment id and is used
   * by edit dialogs that already have the row loaded.
   */
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  @Mutation(() => BatchFeedAssignmentResponse)
  async updateBatchFeedAssignment(
    @Args('input') input: UpdateBatchFeedAssignmentInput,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: { sub: string },
  ): Promise<BatchFeedAssignmentResponse> {
    this.logger.log(`Updating feed assignment ${input.id} for tenant ${tenantId}`);

    const existing = await this.feedAssignmentRepo.findOne({
      where: { id: input.id, tenantId, isDeleted: false },
    });
    if (!existing) {
      throw new NotFoundException(`Feed assignment ${input.id} not found`);
    }

    if (input.feedAssignments !== undefined) {
      for (const entry of input.feedAssignments) {
        const feed = await this.feedRepo.findOne({
          where: { id: entry.feedId, tenantId, isDeleted: false },
        });
        if (!feed) {
          throw new NotFoundException(`Feed ${entry.feedId} not found`);
        }
      }
      existing.feedAssignments = input.feedAssignments.map((entry, index) => ({
        feedId: entry.feedId,
        feedCode: entry.feedCode,
        feedName: entry.feedName,
        minWeightG: entry.minWeightG,
        maxWeightG: entry.maxWeightG,
        priority: entry.priority ?? index + 1,
      }));
    }

    if (input.notes !== undefined) {
      existing.notes = input.notes;
    }

    if (input.isActive !== undefined) {
      existing.isActive = input.isActive;
    }

    existing.updatedBy = user.sub;
    const saved = await this.feedAssignmentRepo.save(existing);
    return this.mapToResponse(saved);
  }

  /**
   * Delete (soft) feed assignment. Routes through the entity's
   * `softDelete()` business method so the deletedAt / deletedBy /
   * isActive=false bookkeeping stays in one place.
   */
  @Roles(Role.TENANT_ADMIN)
  @Mutation(() => Boolean)
  async deleteBatchFeedAssignment(
    @Args('id', { type: () => ID }) id: string,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: { sub: string },
  ): Promise<boolean> {
    this.logger.log(`Deleting feed assignment ${id} for tenant ${tenantId}`);

    const existing = await this.feedAssignmentRepo.findOne({
      where: { id, tenantId, isDeleted: false },
    });
    if (!existing) return false;

    existing.softDelete(user.sub);
    await this.feedAssignmentRepo.save(existing);
    return true;
  }

  /**
   * Restore a soft-deleted feed assignment. TENANT_ADMIN only —
   * follows the uniform restore-mutation pattern PR-47 established
   * (Feed / Chemical / Supplier / Species / Consumable / Site /
   * Department / System / FeedingProgram). The 5th of those entities
   * (BatchFeedAssignment) was held back at PR-47 (FARM-MEDIUM-002)
   * because the resolver was on raw SQL while RestoreService is
   * repo-based; converging on repos in this PR closes that gap.
   *
   * The (tenantId, batchId) UNIQUE index makes uniqueness checking
   * load-bearing: if a soft-deleted assignment for batch X is
   * restored while another active assignment already exists for
   * batch X, the DB-level unique index would fire. RestoreService.
   * assertUniqueness pre-checks and surfaces a
   * RestoreUniquenessConflictError with a clear message.
   *
   * Phase 4.2 — closes the FARM-MEDIUM-002 last gap.
   */
  @Roles(Role.TENANT_ADMIN)
  @Mutation(() => BatchFeedAssignmentResponse)
  async restoreBatchFeedAssignment(
    @Args('id', { type: () => ID }) id: string,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: { sub: string; name?: string },
  ): Promise<BatchFeedAssignmentResponse> {
    this.logger.log(`Restoring feed assignment ${id} for tenant ${tenantId}`);
    const restored = await this.restoreService.restore(
      this.feedAssignmentRepo,
      BatchFeedAssignment,
      id,
      { tenantId, userId: user.sub, userName: user.name },
      {
        // (tenantId, batchId) UNIQUE — see batch-feed-assignment.entity.ts:43
        uniqueKeys: [['batchId']],
      },
    );
    return this.mapToResponse(restored);
  }

  /**
   * Map entity to GraphQL response. The JSONB column is already
   * deserialized to an array by TypeORM; the legacy raw-SQL path
   * had to JSON.parse a string when the driver returned text — that
   * branch is no longer reachable but kept defensively for any
   * caller that still hands in a string-typed test fixture.
   */
  private mapToResponse(assignment: BatchFeedAssignment): BatchFeedAssignmentResponse {
    const feedAssignments = Array.isArray(assignment.feedAssignments)
      ? assignment.feedAssignments
      : typeof assignment.feedAssignments === 'string'
        ? (JSON.parse(assignment.feedAssignments) as FeedAssignmentEntry[])
        : [];

    return {
      id: assignment.id,
      tenantId: assignment.tenantId,
      batchId: assignment.batchId,
      feedAssignments,
      isActive: assignment.isActive,
      notes: assignment.notes,
      createdAt: assignment.createdAt,
      updatedAt: assignment.updatedAt,
      createdBy: assignment.createdBy,
      updatedBy: assignment.updatedBy,
    };
  }
}
