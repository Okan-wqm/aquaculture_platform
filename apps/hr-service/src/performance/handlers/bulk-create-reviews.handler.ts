import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { Logger, InternalServerErrorException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ObjectType, Field, Int } from '@nestjs/graphql';
import { BulkCreateReviewsCommand } from '../commands/bulk-create-reviews.command';
import { PerformanceReview, ReviewStatus } from '../entities/performance-review.entity';
import { Employee } from '../../hr/entities/employee.entity';
import { tenantManagerRepo } from '@aquaculture/backend-common/database';

@ObjectType()
export class BulkCreateReviewsResult {
  @Field(() => Int)
  created!: number;

  @Field(() => Int)
  skipped!: number;

  @Field(() => [String])
  errors!: string[];
}

/**
 * WHY THIS FILE EXISTS:
 * Backend for the FE `BulkCreateReviews` mutation (performance.operations.ts).
 * The mutation 400'd before this handler existed (FE shipped ahead of backend).
 *
 * Mirrors CreatePerformanceReviewHandler (single QueryRunner transaction,
 * tenantManagerRepo for tenant-scoped writes — never raw getRepository) but
 * batched: every valid spec is created in ONE transaction so the kick-off of a
 * review cycle is atomic. Invalid specs (unknown employee/reviewer, bad period,
 * or a duplicate review for the same employee+period+type) are SKIPPED with a
 * recorded error string instead of aborting the whole batch — the FE renders
 * `created/skipped/errors`.
 *
 * Tenant isolation: employee/reviewer lookups and the review insert all go
 * through tenantManagerRepo, which injects tenantId on every query/write.
 */
@CommandHandler(BulkCreateReviewsCommand)
export class BulkCreateReviewsHandler implements ICommandHandler<BulkCreateReviewsCommand> {
  private readonly logger = new Logger(BulkCreateReviewsHandler.name);

  constructor(private readonly dataSource: DataSource) {}

  async execute(command: BulkCreateReviewsCommand): Promise<BulkCreateReviewsResult> {
    const { tenantId, userId, reviews } = command;

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    let created = 0;
    let skipped = 0;
    const errors: string[] = [];

    try {
      const employeeRepo = tenantManagerRepo(queryRunner.manager, Employee, tenantId);
      const reviewRepo = tenantManagerRepo(queryRunner.manager, PerformanceReview, tenantId);

      let rowIndex = 0;
      for (const spec of reviews) {
        rowIndex += 1;
        const i = rowIndex - 1;

        const employee = await employeeRepo.findOne({
          where: { id: spec.employeeId, tenantId, isDeleted: false },
        });
        if (!employee) {
          skipped += 1;
          errors.push(`Row ${i + 1}: employee ${spec.employeeId} not found`);
          continue;
        }

        const reviewer = await employeeRepo.findOne({
          where: { id: spec.reviewerId, tenantId, isDeleted: false },
        });
        if (!reviewer) {
          skipped += 1;
          errors.push(`Row ${i + 1}: reviewer ${spec.reviewerId} not found`);
          continue;
        }

        if (new Date(spec.periodStart) >= new Date(spec.periodEnd)) {
          skipped += 1;
          errors.push(`Row ${i + 1}: period start must be before period end`);
          continue;
        }

        // De-dupe: one review per employee + period type + exact period window.
        const existing = await reviewRepo.findOne({
          where: {
            tenantId,
            employeeId: spec.employeeId,
            periodType: spec.periodType,
            periodStart: new Date(spec.periodStart),
            periodEnd: new Date(spec.periodEnd),
            isDeleted: false,
          },
        });
        if (existing) {
          skipped += 1;
          errors.push(
            `Row ${i + 1}: review already exists for employee ${spec.employeeId} in this period`,
          );
          continue;
        }

        const review = reviewRepo.create({
          tenantId,
          employeeId: spec.employeeId,
          reviewerId: spec.reviewerId,
          periodType: spec.periodType,
          periodStart: new Date(spec.periodStart),
          periodEnd: new Date(spec.periodEnd),
          status: ReviewStatus.DRAFT,
          createdBy: userId,
          updatedBy: userId,
        });
        await reviewRepo.save(review);
        created += 1;
      }

      await queryRunner.commitTransaction();

      return { created, skipped, errors };
    } catch (error) {
      await queryRunner.rollbackTransaction();

      this.logger.error(
        `Failed bulk review creation for tenant ${tenantId}: ${error instanceof Error ? error.message : 'Unknown error'}`,
        error instanceof Error ? error.stack : undefined,
      );

      throw new InternalServerErrorException('Failed to bulk create performance reviews');
    } finally {
      await queryRunner.release();
    }
  }
}
