/**
 * Feeding Cron Service - Scheduled Jobs
 *
 * Handles scheduled tasks for feeding management:
 * - Daily plan generation at 06:00
 * - Temperature readings update hourly (offset to 06:15 to avoid race with daily plan)
 * - Feed transition checks
 *
 * Features:
 * - Distributed locking via PostgreSQL advisory locks for multi-instance deployments
 * - Tenant isolation with proper grouping and error handling
 * - Batch processing with pagination to handle large datasets
 * - Idempotency through UPSERT patterns
 * - Retry mechanism with exponential backoff for transient failures
 * - Event emission for monitoring and alerting
 * - Structured logging with correlation IDs
 * - Telemetry/metrics collection
 *
 * @module Feeding
 */
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import * as crypto from 'crypto';
import { withTenantContext } from '@aquaculture/backend-common/context';
import { listTenantSchemas } from '@aquaculture/backend-common/database';
import { FeedingProgram, FeedingProgramStatus } from '../entities/feeding-program.entity';
import { FeedingProgramTank } from '../entities/feeding-program-tank.entity';
import { DailyFeedingExecution, ExecutionStatus } from '../entities/daily-feeding-execution.entity';
import { DailyFeedingExecutionService } from './daily-feeding-execution.service';
import { FeedingProgramService } from './feeding-program.service';

// ============================================================================
// INTERFACES
// ============================================================================

interface JobContext {
  jobId: string;
  jobName: string;
  startTime: number;
  tenantId?: string;
}

interface TenantJobResult {
  tenantId: string;
  generated: number;
  errors: string[];
  duration: number;
}

interface CronJobMetrics {
  jobName: string;
  jobId: string;
  startTime: Date;
  endTime: Date;
  duration: number;
  success: boolean;
  tenantsProcessed: number;
  totalRecords: number;
  totalErrors: number;
  errorsByTenant: Record<string, string[]>;
}

interface TransitionWarningRow {
  id: string;
  tenantId: string;
  equipmentCode: string;
  equipmentName: string;
  calculations: Record<string, any>;
}

// ============================================================================
// CONSTANTS
// ============================================================================

const BATCH_SIZE = 100; // Process programs in batches
const CLEANUP_BATCH_SIZE = 1000; // Delete records in batches
const MAX_RETRIES = 3;
const BASE_RETRY_DELAY_MS = 1000;
const ADVISORY_LOCK_NAMESPACE = 0x46454544; // 'FEED' in hex

// ============================================================================
// SERVICE
// ============================================================================

@Injectable()
export class FeedingCronService {
  private readonly logger = new Logger(FeedingCronService.name);

  constructor(
    @InjectRepository(FeedingProgram)
    private readonly programRepo: Repository<FeedingProgram>,
    @InjectRepository(FeedingProgramTank)
    private readonly programTankRepo: Repository<FeedingProgramTank>,
    @InjectRepository(DailyFeedingExecution)
    private readonly executionRepo: Repository<DailyFeedingExecution>,
    private readonly executionService: DailyFeedingExecutionService,
    private readonly programService: FeedingProgramService,
    private readonly dataSource: DataSource,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  // ==========================================================================
  // DISTRIBUTED LOCKING
  // ==========================================================================

  /**
   * Generate advisory lock key from job name
   * Creates a deterministic 32-bit integer for PostgreSQL advisory locks
   */
  private getAdvisoryLockKey(jobName: string): number {
    /** SEC-L02: Use SHA-256 instead of MD5. MD5 has known collision vulnerabilities
     *  and is prohibited by NIST SP 800-131A for any new application. */
    const hash = crypto.createHash('sha256').update(jobName).digest();
    return hash.readInt32LE(0);
  }

  /**
   * Try to acquire PostgreSQL advisory lock (non-blocking)
   * Returns true if lock was acquired, false if another instance holds it
   */
  private async tryAcquireAdvisoryLock(jobName: string): Promise<boolean> {
    const lockKey = this.getAdvisoryLockKey(jobName);
    const result = await this.dataSource.query(`SELECT pg_try_advisory_lock($1, $2) as acquired`, [
      ADVISORY_LOCK_NAMESPACE,
      lockKey,
    ]);
    return result[0]?.acquired === true;
  }

  /**
   * Release PostgreSQL advisory lock
   */
  private async releaseAdvisoryLock(jobName: string): Promise<void> {
    const lockKey = this.getAdvisoryLockKey(jobName);
    await this.dataSource.query(`SELECT pg_advisory_unlock($1, $2)`, [
      ADVISORY_LOCK_NAMESPACE,
      lockKey,
    ]);
  }

  // ==========================================================================
  // RETRY MECHANISM
  // ==========================================================================

  /**
   * Execute function with retry and exponential backoff
   */
  private async withRetry<T>(
    fn: () => Promise<T>,
    context: JobContext,
    operationName: string,
  ): Promise<T> {
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        if (attempt < MAX_RETRIES) {
          const delay = BASE_RETRY_DELAY_MS * Math.pow(2, attempt - 1);
          this.logger.warn(
            `Retry ${attempt}/${MAX_RETRIES} for ${operationName} after ${delay}ms`,
            { jobId: context.jobId, error: lastError.message },
          );
          await this.sleep(delay);
        }
      }
    }

    throw lastError;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // ==========================================================================
  // STRUCTURED LOGGING HELPERS
  // ==========================================================================

  private createJobContext(jobName: string, tenantId?: string): JobContext {
    return {
      jobId: `${jobName}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
      jobName,
      startTime: Date.now(),
      tenantId,
    };
  }

  private logJobStart(context: JobContext, message: string): void {
    this.logger.log(message, {
      jobId: context.jobId,
      jobName: context.jobName,
      tenantId: context.tenantId,
    });
  }

  private logJobEnd(context: JobContext, metrics: Partial<CronJobMetrics>): void {
    const duration = Date.now() - context.startTime;
    this.logger.log(`Job ${context.jobName} completed in ${duration}ms`, {
      jobId: context.jobId,
      jobName: context.jobName,
      tenantId: context.tenantId,
      duration,
      ...metrics,
    });
  }

  private logJobError(context: JobContext, message: string, error: Error): void {
    this.logger.error(message, error.stack, {
      jobId: context.jobId,
      jobName: context.jobName,
      tenantId: context.tenantId,
      errorMessage: error.message,
    });
  }

  // ==========================================================================
  // EVENT EMISSION
  // ==========================================================================

  private emitJobMetrics(metrics: CronJobMetrics): void {
    this.eventEmitter.emit('cron.job.completed', metrics);

    if (!metrics.success || metrics.totalErrors > 0) {
      this.eventEmitter.emit('cron.job.failed', {
        jobName: metrics.jobName,
        jobId: metrics.jobId,
        errorCount: metrics.totalErrors,
        errorsByTenant: metrics.errorsByTenant,
        duration: metrics.duration,
      });
    }
  }

  private emitTenantError(
    jobName: string,
    tenantId: string,
    errors: string[],
    context: JobContext,
  ): void {
    this.eventEmitter.emit('cron.tenant.error', {
      jobName,
      jobId: context.jobId,
      tenantId,
      errors,
      timestamp: new Date().toISOString(),
    });
  }

  // ==========================================================================
  // TENANT SCHEMA DISCOVERY
  // ==========================================================================

  // getTenantSchemas replaced by listTenantSchemas from @aquaculture/backend-common

  // ==========================================================================
  // DAILY PLAN GENERATION (06:00)
  // ==========================================================================

  /**
   * Generate daily feeding plans at 06:00 every day
   * Creates DailyFeedingExecution for each active tank in active programs
   *
   * Improvements:
   * - Distributed locking for multi-instance deployments
   * - Tenant isolation with proper grouping
   * - Batch processing with pagination
   * - Idempotency through existing record checks
   * - Retry mechanism for transient failures
   * - Event emission for monitoring
   * - Structured logging with correlation IDs
   */
  @Cron('0 6 * * *', {
    name: 'generate-daily-feeding-plans',
    timeZone: 'Europe/Istanbul',
  })
  async generateDailyPlans(): Promise<void> {
    const context = this.createJobContext('generate-daily-feeding-plans');
    this.logJobStart(context, 'Starting daily feeding plan generation...');

    const metrics: CronJobMetrics = {
      jobName: context.jobName,
      jobId: context.jobId,
      startTime: new Date(),
      endTime: new Date(),
      duration: 0,
      success: false,
      tenantsProcessed: 0,
      totalRecords: 0,
      totalErrors: 0,
      errorsByTenant: {},
    };

    // Try to acquire distributed lock
    const lockAcquired = await this.tryAcquireAdvisoryLock(context.jobName);
    if (!lockAcquired) {
      this.logger.log('Another instance is running this job, skipping', {
        jobId: context.jobId,
      });
      return;
    }

    try {
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      // Discover all tenant schemas from information_schema
      const tenantSchemas = await listTenantSchemas(this.dataSource);

      if (tenantSchemas.length === 0) {
        this.logger.log('No tenant schemas found', { jobId: context.jobId });
        metrics.success = true;
        return;
      }

      this.logger.log(`Discovered ${tenantSchemas.length} tenant schemas`, {
        jobId: context.jobId,
      });

      // Process each tenant schema using withTenantContext() for proper
      // AsyncLocalStorage isolation. Raw queryRunner + SET search_path is
      // replaced by the centralized withTenantContext() which validates the
      // tenantId as UUID and sets up search_path via TenantConnectionBootstrap.
      for (const schema of tenantSchemas) {
        try {
          // Discovery query: fetch tenant-program pairs from this schema.
          // This uses a short-lived queryRunner only for read discovery.
          const discoveryRunner = this.dataSource.createQueryRunner();
          await discoveryRunner.connect();

          let programsByTenant: Map<string, Array<{ id: string; code: string; tenantId: string }>>;
          let totalProgramCount = 0;
          try {
            await discoveryRunner.query(`SET search_path TO "${schema}", farm, public`);

            let offset = 0;
            let hasMore = true;
            programsByTenant = new Map<
              string,
              Array<{ id: string; code: string; tenantId: string }>
            >();

            while (hasMore) {
              const batch: Array<{ id: string; code: string; tenantId: string }> =
                await discoveryRunner.query(
                  `SELECT id, code, "tenantId"
                 FROM feeding_programs
                 WHERE status = $1
                 ORDER BY "tenantId" ASC, id ASC
                 OFFSET $2 LIMIT $3`,
                  [FeedingProgramStatus.ACTIVE, offset, BATCH_SIZE],
                );

              if (batch.length === 0) {
                hasMore = false;
                break;
              }

              for (const program of batch) {
                const programs = programsByTenant.get(program.tenantId) || [];
                programs.push(program);
                programsByTenant.set(program.tenantId, programs);
              }

              offset += batch.length;
              totalProgramCount = offset;
              hasMore = batch.length === BATCH_SIZE;
            }
          } finally {
            await discoveryRunner.query('RESET search_path').catch(() => {});
            await discoveryRunner.release();
          }

          if (programsByTenant.size === 0) {
            continue;
          }

          this.logger.log(
            `Schema ${schema}: found ${totalProgramCount} active programs across ${programsByTenant.size} tenants`,
            { jobId: context.jobId },
          );

          // Process each tenant's programs within withTenantContext()
          for (const [tenantId, programs] of programsByTenant) {
            const tenantContext: JobContext = { ...context, tenantId };
            const result: TenantJobResult = {
              tenantId,
              generated: 0,
              errors: [],
              duration: 0,
            };
            const tenantStart = Date.now();

            this.logger.debug(
              `Processing ${programs.length} programs for tenant ${tenantId} in schema ${schema}`,
              { jobId: context.jobId, tenantId },
            );

            // withTenantContext() validates tenantId as UUID and establishes
            // AsyncLocalStorage context so TenantConnectionBootstrap sets the
            // correct search_path on every DB connection acquired within.
            await withTenantContext(tenantId, async () => {
              for (const program of programs) {
                try {
                  const planResult = await this.withRetry(
                    () =>
                      this.executionService.generateDailyPlan(program.id, today, program.tenantId),
                    tenantContext,
                    `generateDailyPlan-${program.code}`,
                  );

                  result.generated += planResult.executionsCreated;

                  if (planResult.errors.length > 0) {
                    result.errors.push(...planResult.errors.map((e) => `${program.code}: ${e}`));
                    this.logger.warn(
                      `Program ${program.code} had ${planResult.errors.length} errors`,
                      {
                        jobId: context.jobId,
                        tenantId,
                        programCode: program.code,
                        errors: planResult.errors,
                      },
                    );
                  }
                } catch (error) {
                  const err = error instanceof Error ? error : new Error(String(error));
                  const errorMsg = `Program ${program.code}: ${err.message}`;
                  result.errors.push(errorMsg);

                  this.logger.error(`Failed to process program ${program.code}`, err.stack, {
                    jobId: context.jobId,
                    tenantId,
                    programCode: program.code,
                    errorMessage: err.message,
                  });
                }
              }
            });

            result.duration = Date.now() - tenantStart;

            this.logger.debug(
              `Tenant ${tenantId} completed: ${result.generated} plans, ${result.errors.length} errors in ${result.duration}ms`,
              { jobId: context.jobId, tenantId },
            );

            metrics.tenantsProcessed++;
            metrics.totalRecords += result.generated;
            metrics.totalErrors += result.errors.length;

            if (result.errors.length > 0) {
              metrics.errorsByTenant[tenantId] = result.errors;
              this.emitTenantError(context.jobName, tenantId, result.errors, context);
            }
          }
        } catch (error) {
          const err = error instanceof Error ? error : new Error(String(error));
          this.logger.error(
            `Daily plan generation failed for schema ${schema}: ${err.message}`,
            err.stack,
            { jobId: context.jobId },
          );
        }
      }

      metrics.success = metrics.totalErrors === 0;
      metrics.endTime = new Date();
      metrics.duration = Date.now() - context.startTime;

      this.logJobEnd(context, {
        tenantsProcessed: metrics.tenantsProcessed,
        totalRecords: metrics.totalRecords,
        totalErrors: metrics.totalErrors,
      });

      // Emit metrics for monitoring/alerting
      this.emitJobMetrics(metrics);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logJobError(context, 'Daily plan generation failed', err);

      metrics.success = false;
      metrics.endTime = new Date();
      metrics.duration = Date.now() - context.startTime;
      this.emitJobMetrics(metrics);
    } finally {
      await this.releaseAdvisoryLock(context.jobName);
    }
  }

  // ==========================================================================
  // DAILY GROWTH ROLL-UP (05:00 - before the 06:00 daily plan)
  // ==========================================================================

  /**
   * Roll up DAILY-mode pending feeding growth once per day, at 05:00 — before
   * generateDailyPlans (06:00) so that day's plans read the rolled-up weight.
   * PER_FEEDING programs already applied their growth inline (growthAppliedAt
   * stamped), so only DAILY executions are pending. applyPendingDailyGrowth is
   * idempotent, so a retry or an extra run never double-applies growth.
   */
  @Cron('0 5 * * *', {
    name: 'apply-daily-growth-rollup',
    timeZone: 'Europe/Istanbul',
  })
  async applyDailyGrowthRollup(): Promise<void> {
    const context = this.createJobContext('apply-daily-growth-rollup');
    this.logJobStart(context, 'Starting daily feeding-growth roll-up...');

    const lockAcquired = await this.tryAcquireAdvisoryLock(context.jobName);
    if (!lockAcquired) {
      this.logger.log('Another instance is running this job, skipping', { jobId: context.jobId });
      return;
    }

    try {
      const tenantSchemas = await listTenantSchemas(this.dataSource);
      let tanksUpdated = 0;
      let executionsRolledUp = 0;

      for (const schema of tenantSchemas) {
        // Discover the tenantIds in this schema that have pending (pending) growth.
        const discoveryRunner = this.dataSource.createQueryRunner();
        await discoveryRunner.connect();
        let tenantIds: string[] = [];
        try {
          await discoveryRunner.query(`SET search_path TO "${schema}", farm, public`);
          const rows: Array<{ tenantId: string }> = await discoveryRunner.query(
            `SELECT DISTINCT "tenantId" FROM "daily_feeding_executions"
              WHERE "status" = $1 AND "growthAppliedAt" IS NULL`,
            [ExecutionStatus.COMPLETED],
          );
          tenantIds = rows.map((r) => r.tenantId).filter(Boolean);
        } finally {
          await discoveryRunner.query('RESET search_path').catch(() => {});
          await discoveryRunner.release();
        }

        for (const tenantId of tenantIds) {
          try {
            const result = await this.executionService.applyPendingDailyGrowth(tenantId);
            tanksUpdated += result.tanksUpdated;
            executionsRolledUp += result.executionsRolledUp;
          } catch (error) {
            const err = error instanceof Error ? error : new Error(String(error));
            this.logger.error(
              `Daily growth roll-up failed for tenant ${tenantId}: ${err.message}`,
              {
                jobId: context.jobId,
                tenantId,
              },
            );
          }
        }
      }

      this.logger.log(
        `Daily growth roll-up complete: ${tanksUpdated} tank(s), ${executionsRolledUp} execution(s)`,
        { jobId: context.jobId },
      );
    } finally {
      await this.releaseAdvisoryLock(context.jobName);
    }
  }

  // ==========================================================================
  // TEMPERATURE UPDATE (06:15 - offset from daily plan)
  // ==========================================================================

  /**
   * Update temperature readings every hour at :15 minutes
   * Offset from :00 to avoid race condition with 06:00 daily plan generation
   *
   * NOTE: Temperature update implementation is incomplete.
   * TODO: Implement sensor service integration when available.
   * WARNING: Currently this method only logs pending executions without updating them.
   */
  @Cron('15 * * * *', {
    name: 'update-temperature-readings',
    timeZone: 'Europe/Istanbul',
  })
  async updateTemperatureReadings(): Promise<void> {
    // Early-return: sensor integration is not yet implemented.
    // Loading 25,000+ ORM objects every hour for a no-op wastes memory and GC cycles.
    // TODO: Remove this guard when sensor-service integration is available.
    this.logger.debug('Temperature update skipped - sensor integration not yet implemented');
    return;
  }

  // ==========================================================================
  // FEED TRANSITION CHECK (07:00)
  // ==========================================================================

  /**
   * Check for feed transitions daily at 07:00
   * Identifies tanks that need to transition to a new feed based on weight
   *
   * Uses GIN index hint for JSONB transition warning queries
   */
  @Cron('0 7 * * *', {
    name: 'check-feed-transitions',
    timeZone: 'Europe/Istanbul',
  })
  async checkFeedTransitions(): Promise<void> {
    const context = this.createJobContext('check-feed-transitions');
    this.logJobStart(context, 'Checking for feed transitions...');

    // Try to acquire distributed lock
    const lockAcquired = await this.tryAcquireAdvisoryLock(context.jobName);
    if (!lockAcquired) {
      this.logger.debug('Another instance is running this job, skipping', {
        jobId: context.jobId,
      });
      return;
    }

    try {
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      // Discover all tenant schemas from information_schema
      const tenantSchemas = await listTenantSchemas(this.dataSource);

      if (tenantSchemas.length === 0) {
        this.logger.log('No tenant schemas found', { jobId: context.jobId });
        return;
      }

      let totalWarnings = 0;
      let tenantsWithWarnings = 0;

      // Process each tenant schema using short-lived discovery queryRunners
      // for read-only raw SQL, then emit events per tenant.
      for (const schema of tenantSchemas) {
        try {
          // Discovery: short-lived queryRunner for GIN-optimized JSONB query
          const discoveryRunner = this.dataSource.createQueryRunner();
          await discoveryRunner.connect();

          let warningsByTenant: Map<string, TransitionWarningRow[]>;
          try {
            await discoveryRunner.query(`SET search_path TO "${schema}", farm, public`);

            let offset = 0;
            let hasMore = true;
            warningsByTenant = new Map<string, TransitionWarningRow[]>();

            while (hasMore) {
              const rows: TransitionWarningRow[] = await discoveryRunner.query(
                `SELECT id, "tenantId", "equipmentCode", "equipmentName", calculations
                 FROM daily_feeding_executions
                 WHERE "executionDate" = $1
                 AND status = $2
                 AND calculations::jsonb ? 'transitionWarning'
                 ORDER BY "tenantId" ASC, id ASC
                 OFFSET $3 LIMIT $4`,
                [today, ExecutionStatus.PLANNED, offset, BATCH_SIZE],
              );

              if (rows.length === 0) {
                hasMore = false;
                break;
              }

              for (const row of rows) {
                const warnings = warningsByTenant.get(row.tenantId) || [];
                warnings.push(row);
                warningsByTenant.set(row.tenantId, warnings);
              }

              offset += rows.length;
              hasMore = rows.length === BATCH_SIZE;
            }
          } finally {
            await discoveryRunner.query('RESET search_path').catch(() => {});
            await discoveryRunner.release();
          }

          if (warningsByTenant.size === 0) {
            continue;
          }

          const schemaWarningCount = Array.from(warningsByTenant.values()).reduce(
            (sum, arr) => sum + arr.length,
            0,
          );
          totalWarnings += schemaWarningCount;
          tenantsWithWarnings += warningsByTenant.size;

          this.logger.log(
            `Schema ${schema}: found ${schemaWarningCount} tanks with transition warnings across ${warningsByTenant.size} tenants`,
            { jobId: context.jobId },
          );

          // Emit events for each tenant's transition warnings
          for (const [tenantId, executions] of warningsByTenant) {
            this.eventEmitter.emit('feeding.transitionWarnings', {
              tenantId,
              jobId: context.jobId,
              date: today,
              warnings: executions.map((e) => ({
                executionId: e.id,
                equipmentCode: e.equipmentCode,
                equipmentName: e.equipmentName,
                currentFeed: e.calculations?.activeFeedCode ?? 'unknown',
                transitionWarning: e.calculations?.transitionWarning,
              })),
            });
          }
        } catch (error) {
          const err = error instanceof Error ? error : new Error(String(error));
          this.logger.error(
            `Feed transition check failed for schema ${schema}: ${err.message}`,
            err.stack,
            { jobId: context.jobId },
          );
        }
      }

      if (totalWarnings === 0) {
        this.logger.log('No feed transitions needed today', { jobId: context.jobId });
      }

      this.logJobEnd(context, {
        tenantsProcessed: tenantsWithWarnings,
        totalRecords: totalWarnings,
      });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logJobError(context, 'Feed transition check failed', err);
    } finally {
      await this.releaseAdvisoryLock(context.jobName);
    }
  }

  // ==========================================================================
  // CLEANUP OLD EXECUTIONS (Monthly)
  // ==========================================================================

  /**
   * Clean up old execution records (older than 1 year)
   * Runs on the 1st of each month at 02:00
   *
   * Uses batch delete with limit to avoid unbounded operations
   */
  @Cron('0 2 1 * *', {
    name: 'cleanup-old-executions',
    timeZone: 'Europe/Istanbul',
  })
  async cleanupOldExecutions(): Promise<void> {
    const context = this.createJobContext('cleanup-old-executions');
    this.logJobStart(context, 'Cleaning up old execution records...');

    // Try to acquire distributed lock
    const lockAcquired = await this.tryAcquireAdvisoryLock(context.jobName);
    if (!lockAcquired) {
      this.logger.debug('Another instance is running this job, skipping', {
        jobId: context.jobId,
      });
      return;
    }

    try {
      const oneYearAgo = new Date();
      oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);

      // Get all distinct tenant IDs that have old executions
      // Use the ORM repository (which respects search_path) with tenantId grouping
      const tenantsWithOldData = await this.executionRepo
        .createQueryBuilder('e')
        .select('DISTINCT e.tenantId', 'tenantId')
        .where('e.executionDate < :cutoff', { cutoff: oneYearAgo })
        .andWhere('e.status IN (:...statuses)', {
          statuses: [ExecutionStatus.COMPLETED, ExecutionStatus.SKIPPED],
        })
        .getRawMany();

      if (!tenantsWithOldData || tenantsWithOldData.length === 0) {
        this.logger.log('No old execution records to clean up', { jobId: context.jobId });
        return;
      }

      this.logger.log(`Found ${tenantsWithOldData.length} tenants with old execution records`, {
        jobId: context.jobId,
      });

      let totalDeleted = 0;
      const deletedByTenant: Record<string, number> = {};

      // Process each tenant using withTenantContext() which:
      // 1. Validates tenantId as UUID (rejects tampered strings)
      // 2. Derives schema name via getTenantSchemaName() (deterministic, safe)
      // 3. Establishes AsyncLocalStorage context for TenantConnectionBootstrap
      //
      // Previous approach used manual schema derivation from application-controlled
      // tenantId strings + SET search_path — a tampered tenantId could redirect to
      // another tenant's schema (schema interpolation vulnerability).
      for (const row of tenantsWithOldData) {
        const tenantId = row.tenantId as string;
        let tenantDeleted = 0;
        let deleted = 0;
        let iterations = 0;
        const maxIterations = 100;

        try {
          await withTenantContext(tenantId, async () => {
            const queryRunner = this.dataSource.createQueryRunner();
            await queryRunner.connect();

            try {
              // Batch delete for this specific tenant
              do {
                const result = await queryRunner.query(
                  `DELETE FROM daily_feeding_executions
                   WHERE id IN (
                     SELECT id FROM daily_feeding_executions
                     WHERE "tenantId" = $1
                     AND "executionDate" < $2
                     AND status = ANY($3)
                     LIMIT $4
                   )`,
                  [
                    tenantId,
                    oneYearAgo,
                    [ExecutionStatus.COMPLETED, ExecutionStatus.SKIPPED],
                    CLEANUP_BATCH_SIZE,
                  ],
                );

                deleted = result?.rowCount ?? (Array.isArray(result) ? 0 : (result?.affected ?? 0));
                tenantDeleted += deleted;
                iterations++;

                if (deleted === CLEANUP_BATCH_SIZE) {
                  await this.sleep(100);
                }
              } while (deleted === CLEANUP_BATCH_SIZE && iterations < maxIterations);
            } finally {
              await queryRunner.release();
            }
          });
        } catch (error) {
          const err = error instanceof Error ? error : new Error(String(error));
          // withTenantContext throws on invalid UUID — skip this tenant
          this.logger.warn(`Skipping cleanup for tenantId ${tenantId}: ${err.message}`, {
            jobId: context.jobId,
          });
          continue;
        }

        if (tenantDeleted > 0) {
          deletedByTenant[tenantId] = tenantDeleted;
          totalDeleted += tenantDeleted;
          this.logger.debug(`Tenant ${tenantId}: deleted ${tenantDeleted} records`, {
            jobId: context.jobId,
            tenantId,
          });
        }

        if (iterations >= maxIterations) {
          this.logger.warn(
            `Cleanup for tenant ${tenantId} reached max iterations, may have more records`,
            { jobId: context.jobId, tenantId, deleted: tenantDeleted },
          );
        }
      }

      this.logJobEnd(context, {
        totalRecords: totalDeleted,
        tenantsProcessed: tenantsWithOldData.length,
      });

      // Emit cleanup metrics
      this.eventEmitter.emit('cron.cleanup.completed', {
        jobId: context.jobId,
        recordsDeleted: totalDeleted,
        deletedByTenant,
        cutoffDate: oneYearAgo,
        tenantsProcessed: tenantsWithOldData.length,
      });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logJobError(context, 'Cleanup failed', err);
    } finally {
      await this.releaseAdvisoryLock(context.jobName);
    }
  }

  // ==========================================================================
  // MANUAL TRIGGERS
  // ==========================================================================

  /**
   * Manual trigger for daily plan generation
   * Can be called from admin API
   *
   * SECURITY: tenantId is required to ensure proper tenant isolation.
   * When programId is not provided, only processes programs belonging to the specified tenant.
   *
   * @param tenantId - Required tenant ID for authorization
   * @param programId - Optional program ID (if not provided, processes all active programs for the tenant)
   * @param date - Optional date (defaults to today)
   * @param requestId - Optional request ID for tracing
   */
  async manualGenerateDailyPlans(
    tenantId: string,
    programId?: string,
    date?: Date,
    requestId?: string,
  ): Promise<{ generated: number; errors: number; errorDetails: string[] }> {
    // SECURITY FIX: Validate tenantId is provided
    if (!tenantId) {
      throw new Error('tenantId is required for manual daily plan generation');
    }

    const context = this.createJobContext('manual-daily-plans');
    context.tenantId = tenantId;
    if (requestId) {
      context.jobId = requestId;
    }

    this.logJobStart(
      context,
      `Manual daily plan generation triggered for ${programId || 'all programs'} in tenant ${tenantId}`,
    );

    const targetDate = date || new Date();
    targetDate.setHours(0, 0, 0, 0);

    let generated = 0;
    let errors = 0;
    const errorDetails: string[] = [];

    try {
      // SECURITY FIX: Always filter by tenantId to ensure tenant isolation
      const whereClause: { status: FeedingProgramStatus; tenantId: string; id?: string } = {
        status: FeedingProgramStatus.ACTIVE,
        tenantId,
      };
      if (programId) {
        whereClause.id = programId;
      }

      // Process in batches
      let offset = 0;
      let hasMore = true;

      while (hasMore) {
        const programs = await this.programRepo.find({
          where: whereClause,
          order: { tenantId: 'ASC', id: 'ASC' },
          skip: offset,
          take: BATCH_SIZE,
        });

        if (programs.length === 0) {
          hasMore = false;
          break;
        }

        for (const program of programs) {
          try {
            const result = await this.withRetry(
              () =>
                this.executionService.generateDailyPlan(program.id, targetDate, program.tenantId),
              context,
              `manualGenerate-${program.code}`,
            );

            generated += result.executionsCreated;
            errors += result.errors.length;

            if (result.errors.length > 0) {
              errorDetails.push(...result.errors.map((e) => `${program.code}: ${e}`));
            }
          } catch (error) {
            const err = error instanceof Error ? error : new Error(String(error));
            this.logger.error(`Failed to generate for program ${program.id}`, err.stack, {
              jobId: context.jobId,
              programId: program.id,
            });
            errors++;
            errorDetails.push(`${program.code}: ${err.message}`);
          }
        }

        offset += programs.length;
        hasMore = programs.length === BATCH_SIZE;
      }
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logJobError(context, 'Manual generation failed', err);
      throw error;
    }

    this.logJobEnd(context, { totalRecords: generated, totalErrors: errors });

    return { generated, errors, errorDetails };
  }
}
