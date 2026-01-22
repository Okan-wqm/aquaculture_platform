/**
 * Batch Feed Assignment Resolver
 *
 * GraphQL mutations and queries for managing feed assignments to batches.
 * Allows assigning different feeds based on fish weight ranges.
 */
import { Resolver, Query, Mutation, Args, ID } from '@nestjs/graphql';
import { UseGuards, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { TenantGuard, CurrentTenant, CurrentUser } from '@platform/backend-common';
import { BatchFeedAssignment } from '../entities/batch-feed-assignment.entity';
import { Batch } from '../entities/batch.entity';
import { Feed } from '../../feed/entities/feed.entity';
import { BatchFeedAssignmentResponse } from '../dto/batch-feed-assignment.response';
import { AssignFeedsToBatchInput, UpdateBatchFeedAssignmentInput } from '../dto/batch-feed-assignment.input';

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
  ) {}

  /**
   * Get feed assignment for a batch
   */
  @Query(() => BatchFeedAssignmentResponse, { nullable: true })
  async batchFeedAssignment(
    @Args('batchId', { type: () => ID }) batchId: string,
    @CurrentTenant() tenantId: string,
  ): Promise<BatchFeedAssignmentResponse | null> {
    const schemaName = `tenant_${tenantId.substring(0, 8)}`;

    const result = await this.feedAssignmentRepo.query(
      `SELECT * FROM "${schemaName}".batch_feed_assignments
       WHERE "tenantId" = $1 AND "batchId" = $2 AND "isDeleted" = false
       LIMIT 1`,
      [tenantId, batchId]
    );

    const assignment = result?.[0];
    if (!assignment) return null;

    return this.mapToResponse(assignment);
  }

  /**
   * Assign feeds to a batch with weight ranges
   * Creates new or updates existing assignment
   */
  @Mutation(() => BatchFeedAssignmentResponse)
  async assignFeedsToBatch(
    @Args('input') input: AssignFeedsToBatchInput,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: { sub: string },
  ): Promise<BatchFeedAssignmentResponse> {
    const schemaName = `tenant_${tenantId.substring(0, 8)}`;
    this.logger.log(`Assigning feeds to batch ${input.batchId} for tenant ${tenantId}`);

    // Validate batch exists
    const batchResult = await this.batchRepo.query(
      `SELECT id FROM "${schemaName}".batches_v2 WHERE "id" = $1 AND "tenantId" = $2 AND "isDeleted" = false`,
      [input.batchId, tenantId]
    );
    if (!batchResult?.[0]) {
      throw new Error(`Batch ${input.batchId} not found`);
    }

    // Validate all feeds exist
    for (const entry of input.feedAssignments) {
      const feedResult = await this.feedRepo.query(
        `SELECT id FROM "${schemaName}".feeds WHERE "id" = $1 AND "tenantId" = $2 AND "isDeleted" = false`,
        [entry.feedId, tenantId]
      );
      if (!feedResult?.[0]) {
        throw new Error(`Feed ${entry.feedId} not found`);
      }
    }

    // Check if assignment already exists
    const existingResult = await this.feedAssignmentRepo.query(
      `SELECT * FROM "${schemaName}".batch_feed_assignments
       WHERE "tenantId" = $1 AND "batchId" = $2 AND "isDeleted" = false
       LIMIT 1`,
      [tenantId, input.batchId]
    );

    const feedAssignments = input.feedAssignments.map((entry, index) => ({
      feedId: entry.feedId,
      feedCode: entry.feedCode,
      feedName: entry.feedName,
      minWeightG: entry.minWeightG,
      maxWeightG: entry.maxWeightG,
      priority: entry.priority ?? index + 1,
    }));

    let assignment: BatchFeedAssignment;

    if (existingResult?.[0]) {
      // Update existing
      await this.feedAssignmentRepo.query(
        `UPDATE "${schemaName}".batch_feed_assignments
         SET "feedAssignments" = $1, "notes" = $2, "updatedBy" = $3, "updatedAt" = NOW(), "version" = "version" + 1
         WHERE "id" = $4 AND "tenantId" = $5`,
        [JSON.stringify(feedAssignments), input.notes || null, user.sub, existingResult[0].id, tenantId]
      );

      const updatedResult = await this.feedAssignmentRepo.query(
        `SELECT * FROM "${schemaName}".batch_feed_assignments WHERE "id" = $1`,
        [existingResult[0].id]
      );
      assignment = updatedResult[0];
    } else {
      // Create new
      const insertResult = await this.feedAssignmentRepo.query(
        `INSERT INTO "${schemaName}".batch_feed_assignments
         ("tenantId", "batchId", "feedAssignments", "notes", "isActive", "isDeleted", "createdBy", "version")
         VALUES ($1, $2, $3, $4, true, false, $5, 1)
         RETURNING *`,
        [tenantId, input.batchId, JSON.stringify(feedAssignments), input.notes || null, user.sub]
      );
      assignment = insertResult[0];
    }

    return this.mapToResponse(assignment);
  }

  /**
   * Update feed assignment
   */
  @Mutation(() => BatchFeedAssignmentResponse)
  async updateBatchFeedAssignment(
    @Args('input') input: UpdateBatchFeedAssignmentInput,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: { sub: string },
  ): Promise<BatchFeedAssignmentResponse> {
    const schemaName = `tenant_${tenantId.substring(0, 8)}`;
    this.logger.log(`Updating feed assignment ${input.id} for tenant ${tenantId}`);

    // Validate assignment exists
    const existingResult = await this.feedAssignmentRepo.query(
      `SELECT * FROM "${schemaName}".batch_feed_assignments
       WHERE "id" = $1 AND "tenantId" = $2 AND "isDeleted" = false`,
      [input.id, tenantId]
    );

    if (!existingResult?.[0]) {
      throw new Error(`Feed assignment ${input.id} not found`);
    }

    const updates: string[] = [];
    const params: any[] = [];
    let paramIndex = 1;

    if (input.feedAssignments !== undefined) {
      // Validate feeds
      for (const entry of input.feedAssignments) {
        const feedResult = await this.feedRepo.query(
          `SELECT id FROM "${schemaName}".feeds WHERE "id" = $1 AND "tenantId" = $2 AND "isDeleted" = false`,
          [entry.feedId, tenantId]
        );
        if (!feedResult?.[0]) {
          throw new Error(`Feed ${entry.feedId} not found`);
        }
      }

      const feedAssignments = input.feedAssignments.map((entry, index) => ({
        feedId: entry.feedId,
        feedCode: entry.feedCode,
        feedName: entry.feedName,
        minWeightG: entry.minWeightG,
        maxWeightG: entry.maxWeightG,
        priority: entry.priority ?? index + 1,
      }));
      updates.push(`"feedAssignments" = $${paramIndex++}`);
      params.push(JSON.stringify(feedAssignments));
    }

    if (input.notes !== undefined) {
      updates.push(`"notes" = $${paramIndex++}`);
      params.push(input.notes);
    }

    if (input.isActive !== undefined) {
      updates.push(`"isActive" = $${paramIndex++}`);
      params.push(input.isActive);
    }

    if (updates.length > 0) {
      updates.push(`"updatedBy" = $${paramIndex++}`);
      params.push(user.sub);
      updates.push(`"updatedAt" = NOW()`);
      updates.push(`"version" = "version" + 1`);

      params.push(input.id);
      params.push(tenantId);

      await this.feedAssignmentRepo.query(
        `UPDATE "${schemaName}".batch_feed_assignments
         SET ${updates.join(', ')}
         WHERE "id" = $${paramIndex++} AND "tenantId" = $${paramIndex}`,
        params
      );
    }

    const updatedResult = await this.feedAssignmentRepo.query(
      `SELECT * FROM "${schemaName}".batch_feed_assignments WHERE "id" = $1`,
      [input.id]
    );

    return this.mapToResponse(updatedResult[0]);
  }

  /**
   * Delete (soft) feed assignment
   */
  @Mutation(() => Boolean)
  async deleteBatchFeedAssignment(
    @Args('id', { type: () => ID }) id: string,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: { sub: string },
  ): Promise<boolean> {
    const schemaName = `tenant_${tenantId.substring(0, 8)}`;
    this.logger.log(`Deleting feed assignment ${id} for tenant ${tenantId}`);

    const result = await this.feedAssignmentRepo.query(
      `UPDATE "${schemaName}".batch_feed_assignments
       SET "isDeleted" = true, "deletedAt" = NOW(), "deletedBy" = $1, "isActive" = false
       WHERE "id" = $2 AND "tenantId" = $3 AND "isDeleted" = false`,
      [user.sub, id, tenantId]
    );

    return result[1] > 0;
  }

  /**
   * Map entity to GraphQL response
   */
  private mapToResponse(assignment: any): BatchFeedAssignmentResponse {
    const feedAssignments = typeof assignment.feedAssignments === 'string'
      ? JSON.parse(assignment.feedAssignments)
      : assignment.feedAssignments;

    return {
      id: assignment.id,
      tenantId: assignment.tenantId,
      batchId: assignment.batchId,
      feedAssignments: feedAssignments || [],
      isActive: assignment.isActive,
      notes: assignment.notes,
      createdAt: assignment.createdAt,
      updatedAt: assignment.updatedAt,
      createdBy: assignment.createdBy,
      updatedBy: assignment.updatedBy,
    };
  }
}
