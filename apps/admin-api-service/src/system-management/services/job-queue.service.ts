import {
  ScheduledJob,
  ScheduledJobRunner,
  type ScheduledJobExecutor,
} from '@aquaculture/backend-common/scheduling';
import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { CronExpression } from '@nestjs/schedule';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, IsNull, LessThan, LessThanOrEqual, Repository } from 'typeorm';

import {
  BackgroundJob,
  JobExecutionLog,
  JobQueue,
  JobStatus,
  JobPriority,
  JobType,
  JobProgress,
  JobRetryPolicy,
} from '../entities/job-queue.entity';

// ============================================================================
// Interfaces
// ============================================================================

export interface JobDefinition {
  name: string;
  queueName: string;
  jobType?: JobType;
  priority?: number;
  payload?: Record<string, unknown>;
  scheduledAt?: Date;
  cronExpression?: string;
  timeoutMs?: number;
  maxAttempts?: number;
  retryPolicy?: JobRetryPolicy;
  tenantId?: string;
  userId?: string;
  dependencies?: string[];
  tags?: string[];
  metadata?: Record<string, unknown>;
}

export interface JobQueueStats {
  queueName: string;
  pending: number;
  running: number;
  completed: number;
  failed: number;
  avgProcessingTime: number;
  throughput: number;
}

export interface JobDashboard {
  totalJobs: number;
  pendingJobs: number;
  runningJobs: number;
  failedJobs: number;
  completedLast24h: number;
  avgProcessingTime: number;
  queueStats: JobQueueStats[];
  recentJobs: BackgroundJob[];
  failedJobsList: BackgroundJob[];
  scheduledJobs: BackgroundJob[];
}

// A handler may resolve to a result object or to nothing. The resolved value
// is consumed by the caller (stored as job.result), so the "nothing" case is
// `undefined`, not `void` — `void` means "the value is unusable" and is
// invalid as a union member (no-invalid-void-type).
export type JobHandler = (job: BackgroundJob) => Promise<Record<string, unknown> | undefined>;

// ============================================================================
// Job Queue Service
// ============================================================================

@Injectable()
export class JobQueueService {
  private readonly logger = new Logger(JobQueueService.name);
  private jobHandlers: Map<string, JobHandler> = new Map();
  private isProcessing = false;
  private workerId: string;

  constructor(
    @InjectRepository(BackgroundJob)
    private readonly jobRepo: Repository<BackgroundJob>,
    @InjectRepository(JobExecutionLog)
    private readonly logRepo: Repository<JobExecutionLog>,
    @InjectRepository(JobQueue)
    private readonly queueRepo: Repository<JobQueue>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    @Inject(ScheduledJobRunner) readonly scheduledJobs: ScheduledJobExecutor,
  ) {
    this.workerId = `worker-${Date.now()}-${Math.random().toString(36).substring(7)}`;
  }

  // ============================================================================
  // Queue Management
  // ============================================================================

  async createQueue(data: {
    name: string;
    description?: string;
    concurrency?: number;
    maxJobsPerSecond?: number;
    defaultMaxRetries?: number;
    defaultTimeoutMs?: number;
    retryPolicy?: JobRetryPolicy;
  }): Promise<JobQueue> {
    const existing = await this.queueRepo.findOne({ where: { name: data.name } });
    if (existing) {
      throw new BadRequestException(`Queue '${data.name}' already exists`);
    }

    const queue = this.queueRepo.create({
      ...data,
      isActive: true,
      isPaused: false,
      concurrency: data.concurrency || 10,
      maxJobsPerSecond: data.maxJobsPerSecond || 100,
      defaultMaxRetries: data.defaultMaxRetries || 3,
      defaultTimeoutMs: data.defaultTimeoutMs || 3600000,
      pendingCount: 0,
      runningCount: 0,
      completedCount: 0,
      failedCount: 0,
    });

    return this.queueRepo.save(queue);
  }

  async updateQueue(name: string, data: Partial<JobQueue>): Promise<JobQueue> {
    const queue = await this.queueRepo.findOne({ where: { name } });
    if (!queue) {
      throw new NotFoundException(`Queue not found: ${name}`);
    }

    Object.assign(queue, data);
    return this.queueRepo.save(queue);
  }

  async pauseQueue(name: string): Promise<JobQueue> {
    return this.updateQueue(name, { isPaused: true });
  }

  async resumeQueue(name: string): Promise<JobQueue> {
    return this.updateQueue(name, { isPaused: false });
  }

  async getQueue(name: string): Promise<JobQueue> {
    const queue = await this.queueRepo.findOne({ where: { name } });
    if (!queue) {
      throw new NotFoundException(`Queue not found: ${name}`);
    }
    return queue;
  }

  async getAllQueues(): Promise<JobQueue[]> {
    return this.queueRepo.find({ order: { name: 'ASC' } });
  }

  // ============================================================================
  // Job Creation
  // ============================================================================

  async createJob(definition: JobDefinition): Promise<BackgroundJob> {
    // Ensure queue exists
    let queue = await this.queueRepo.findOne({ where: { name: definition.queueName } });
    if (!queue) {
      // Auto-create queue with defaults
      queue = await this.createQueue({ name: definition.queueName });
    }

    const job = this.jobRepo.create({
      name: definition.name,
      queueName: definition.queueName,
      jobType: definition.jobType || JobType.IMMEDIATE,
      status: JobStatus.PENDING,
      priority: definition.priority ?? JobPriority.NORMAL,
      payload: definition.payload,
      scheduledAt: definition.scheduledAt,
      cronExpression: definition.cronExpression,
      isRecurring: !!definition.cronExpression,
      timeoutMs: definition.timeoutMs || queue.defaultTimeoutMs,
      maxAttempts: definition.maxAttempts || queue.defaultMaxRetries,
      retryPolicy: definition.retryPolicy || queue.retryPolicy,
      tenantId: definition.tenantId,
      userId: definition.userId,
      dependencies: definition.dependencies,
      tags: definition.tags,
      metadata: definition.metadata,
      attempts: 0,
    });

    if (definition.cronExpression) {
      job.nextRunAt = this.calculateNextRun(definition.cronExpression);
    }

    const saved = await this.jobRepo.save(job);

    // Update queue counts
    await this.updateQueueCounts(definition.queueName);

    this.logger.log(`Created job: ${saved.name} (${saved.id})`);
    return saved;
  }

  async scheduleJob(definition: JobDefinition, scheduledAt: Date): Promise<BackgroundJob> {
    return this.createJob({
      ...definition,
      jobType: JobType.SCHEDULED,
      scheduledAt,
    });
  }

  async scheduleRecurringJob(
    definition: JobDefinition,
    cronExpression: string,
  ): Promise<BackgroundJob> {
    return this.createJob({
      ...definition,
      jobType: JobType.RECURRING,
      cronExpression,
    });
  }

  // ============================================================================
  // Job Handler Registration
  // ============================================================================

  registerHandler(jobName: string, handler: JobHandler): void {
    this.jobHandlers.set(jobName, handler);
    this.logger.log(`Registered handler for job: ${jobName}`);
  }

  unregisterHandler(jobName: string): void {
    this.jobHandlers.delete(jobName);
  }

  // ============================================================================
  // Job Processing
  // ============================================================================

  @ScheduledJob({ name: 'job-queue.process-jobs', cron: CronExpression.EVERY_10_SECONDS })
  async processJobs(): Promise<void> {
    if (this.isProcessing) return;

    this.isProcessing = true;

    try {
      const queues = await this.queueRepo.find({
        where: { isActive: true, isPaused: false },
      });

      for (const queue of queues) {
        await this.processQueueJobs(queue);
      }
    } finally {
      this.isProcessing = false;
    }
  }

  private async processQueueJobs(queue: JobQueue): Promise<void> {
    const runningCount = await this.jobRepo.count({
      where: { queueName: queue.name, status: JobStatus.RUNNING },
    });
    if (runningCount >= queue.concurrency) return;

    const claimed = await this.claimReadyJobs(queue.name, queue.concurrency - runningCount);
    for (const job of claimed) {
      await this.executeJob(job);
    }
  }

  /**
   * Claim up to `slots` ready jobs atomically (ADMIN-HIGH-013).
   *
   * The candidate rows are selected `FOR UPDATE SKIP LOCKED` and moved to
   * RUNNING inside the same transaction, so two replicas — or one replica's
   * overlapping ticks — can never execute the same job: a row another
   * transaction holds is skipped, not waited for, and a row this transaction
   * claims is RUNNING before anyone else can see it as ready. Jobs whose
   * dependencies are still open are left unclaimed (their lock is released at
   * commit) and picked up by a later tick.
   */
  private async claimReadyJobs(queueName: string, slots: number): Promise<BackgroundJob[]> {
    if (slots <= 0) return [];
    return this.dataSource.transaction(async (manager) => {
      const now = new Date();
      const candidates = await manager
        .createQueryBuilder(BackgroundJob, 'j')
        .setLock('pessimistic_write')
        .setOnLocked('skip_locked')
        .where('j.queueName = :queueName', { queueName })
        .andWhere('j.status IN (:...statuses)', {
          statuses: [JobStatus.PENDING, JobStatus.SCHEDULED, JobStatus.RETRYING],
        })
        .andWhere('(j.scheduledAt IS NULL OR j.scheduledAt <= :now)', { now })
        .andWhere('(j.nextRetryAt IS NULL OR j.nextRetryAt <= :now)', { now })
        .andWhere('j.isPaused = false')
        .orderBy('j.priority', 'DESC')
        .addOrderBy('j.createdAt', 'ASC')
        .take(slots)
        .getMany();

      const claimed: BackgroundJob[] = [];
      for (const job of candidates) {
        // A job with no handler in this process is left for a replica that has
        // one; claiming it would park it in RUNNING with nobody to run it.
        if (!this.jobHandlers.has(job.name)) continue;
        if (job.dependencies && job.dependencies.length > 0) {
          const pendingDeps = await manager.count(BackgroundJob, {
            where: {
              id: In(job.dependencies),
              status: In([
                JobStatus.PENDING,
                JobStatus.RUNNING,
                JobStatus.SCHEDULED,
                JobStatus.RETRYING,
              ]),
            },
          });
          if (pendingDeps > 0) continue;
        }
        job.status = JobStatus.RUNNING;
        job.startedAt = now;
        job.attempts += 1;
        job.workerId = this.workerId;
        claimed.push(await manager.save(BackgroundJob, job));
      }
      return claimed;
    });
  }

  private async executeJob(job: BackgroundJob): Promise<void> {
    const handler = this.jobHandlers.get(job.name);
    if (!handler) {
      // Unreachable after claimReadyJobs, which only claims jobs this process
      // can run; if it ever happens the row must not stay RUNNING forever.
      job.status = JobStatus.FAILED;
      job.errorMessage = `No handler registered for job: ${job.name}`;
      job.completedAt = new Date();
      await this.jobRepo.save(job);
      this.logger.error(job.errorMessage);
      return;
    }

    const startTime = Date.now();

    // The job arrives already claimed (RUNNING, attempts advanced, worker set)
    // by claimReadyJobs' locked transaction; this method only executes it.

    // Create execution log
    const log = this.logRepo.create({
      jobId: job.id,
      attemptNumber: job.attempts,
      status: JobStatus.RUNNING,
      startedAt: job.startedAt,
      workerId: this.workerId,
      timestamp: new Date().toISOString(),
    });
    await this.logRepo.save(log);

    try {
      // Execute with timeout
      const result = await this.executeWithTimeout(handler, job, job.timeoutMs);

      // Mark as completed
      job.status = JobStatus.COMPLETED;
      job.completedAt = new Date();
      job.durationMs = Date.now() - startTime;
      job.result = result || {};

      // Update log
      log.status = JobStatus.COMPLETED;
      log.completedAt = job.completedAt;
      log.durationMs = job.durationMs;
      log.result = job.result;

      // Handle recurring jobs
      if (job.isRecurring && job.cronExpression) {
        job.lastRunAt = new Date();
        job.nextRunAt = this.calculateNextRun(job.cronExpression);
        job.status = JobStatus.SCHEDULED;
      }

      this.logger.log(`Job completed: ${job.name} (${job.id}) in ${job.durationMs}ms`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const stackTrace = error instanceof Error ? error.stack : undefined;

      job.errorMessage = errorMessage;
      job.stackTrace = stackTrace ?? null!;
      job.durationMs = Date.now() - startTime;

      // Update log
      log.status = JobStatus.FAILED;
      log.completedAt = new Date();
      log.durationMs = job.durationMs;
      log.errorMessage = errorMessage;
      log.stackTrace = stackTrace ?? null!;

      // Check for retry
      if (job.attempts < job.maxAttempts) {
        job.status = JobStatus.RETRYING;
        job.nextRetryAt = this.calculateRetryTime(job);
        this.logger.warn(
          `Job failed, will retry: ${job.name} (${job.id}) - attempt ${job.attempts}/${job.maxAttempts}`,
        );
      } else {
        job.status = JobStatus.FAILED;
        this.logger.error(`Job failed permanently: ${job.name} (${job.id}) - ${errorMessage}`);
      }
    }

    await this.jobRepo.save(job);
    await this.logRepo.save(log);
    await this.updateQueueCounts(job.queueName);
  }

  private async executeWithTimeout(
    handler: JobHandler,
    job: BackgroundJob,
    timeoutMs: number,
  ): Promise<Record<string, unknown> | undefined> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Job timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      handler(job)
        .then((result) => {
          clearTimeout(timeout);
          resolve(result);
        })
        .catch((error: unknown) => {
          clearTimeout(timeout);
          // Promise rejections must carry an Error (prefer-promise-reject-errors).
          // A handler can reject with a non-Error (string/object); normalize so
          // downstream catch sites can rely on Error semantics (.message/.stack).
          reject(error instanceof Error ? error : new Error(String(error)));
        });
    });
  }

  private calculateRetryTime(job: BackgroundJob): Date {
    const policy = job.retryPolicy || {
      maxRetries: 3,
      retryDelay: 60000,
      exponentialBackoff: true,
      backoffMultiplier: 2,
      maxDelay: 3600000,
    };

    let delay = policy.retryDelay;

    if (policy.exponentialBackoff) {
      delay = policy.retryDelay * Math.pow(policy.backoffMultiplier || 2, job.attempts - 1);
    }

    if (policy.maxDelay) {
      delay = Math.min(delay, policy.maxDelay);
    }

    return new Date(Date.now() + delay);
  }

  private calculateNextRun(cronExpression: string): Date {
    // Simple cron parser - in production, use a library like cron-parser
    // This is a simplified implementation
    const now = new Date();
    const nextMinute = new Date(now);
    nextMinute.setSeconds(0);
    nextMinute.setMilliseconds(0);
    nextMinute.setMinutes(nextMinute.getMinutes() + 1);
    return nextMinute;
  }

  // ============================================================================
  // Job Management
  // ============================================================================

  async getJob(id: string): Promise<BackgroundJob> {
    const job = await this.jobRepo.findOne({ where: { id } });
    if (!job) {
      throw new NotFoundException(`Job not found: ${id}`);
    }
    return job;
  }

  async cancelJob(id: string): Promise<BackgroundJob> {
    const job = await this.getJob(id);

    if (job.status === JobStatus.COMPLETED || job.status === JobStatus.CANCELLED) {
      throw new BadRequestException(`Cannot cancel job in status: ${job.status}`);
    }

    job.status = JobStatus.CANCELLED;
    const saved = await this.jobRepo.save(job);
    await this.updateQueueCounts(job.queueName);

    this.logger.log(`Job cancelled: ${job.name} (${job.id})`);
    return saved;
  }

  async retryJob(id: string): Promise<BackgroundJob> {
    const job = await this.getJob(id);

    if (job.status !== JobStatus.FAILED && job.status !== JobStatus.CANCELLED) {
      throw new BadRequestException(`Cannot retry job in status: ${job.status}`);
    }

    job.status = JobStatus.PENDING;
    job.attempts = 0;
    job.errorMessage = null!;
    job.stackTrace = null!;
    job.nextRetryAt = null!;

    const saved = await this.jobRepo.save(job);
    await this.updateQueueCounts(job.queueName);

    this.logger.log(`Job retried: ${job.name} (${job.id})`);
    return saved;
  }

  async pauseJob(id: string): Promise<BackgroundJob> {
    const job = await this.getJob(id);
    job.isPaused = true;
    return this.jobRepo.save(job);
  }

  async resumeJob(id: string): Promise<BackgroundJob> {
    const job = await this.getJob(id);
    job.isPaused = false;
    return this.jobRepo.save(job);
  }

  async updateJobProgress(id: string, progress: JobProgress): Promise<BackgroundJob> {
    const job = await this.getJob(id);
    job.progress = progress;
    return this.jobRepo.save(job);
  }

  async queryJobs(params: {
    queueName?: string;
    status?: JobStatus;
    jobType?: JobType;
    tenantId?: string;
    tags?: string[];
    search?: string;
    page?: number;
    limit?: number;
  }): Promise<{ items: BackgroundJob[]; total: number }> {
    const query = this.jobRepo.createQueryBuilder('j');

    if (params.queueName) {
      query.andWhere('j.queueName = :queueName', { queueName: params.queueName });
    }
    if (params.status) {
      query.andWhere('j.status = :status', { status: params.status });
    }
    if (params.jobType) {
      query.andWhere('j.jobType = :jobType', { jobType: params.jobType });
    }
    if (params.tenantId) {
      query.andWhere('j.tenantId = :tenantId', { tenantId: params.tenantId });
    }
    if (params.tags && params.tags.length > 0) {
      query.andWhere('j.tags @> :tags', { tags: JSON.stringify(params.tags) });
    }
    if (params.search) {
      query.andWhere('j.name ILIKE :search', { search: `%${params.search}%` });
    }

    query.orderBy('j.createdAt', 'DESC');

    const page = params.page || 1;
    const limit = params.limit || 20;
    query.skip((page - 1) * limit).take(limit);

    const [items, total] = await query.getManyAndCount();
    return { items, total };
  }

  // ============================================================================
  // Job Execution Logs
  // ============================================================================

  async getJobLogs(
    jobId: string,
    params: { page?: number; limit?: number },
  ): Promise<{ items: JobExecutionLog[]; total: number }> {
    const page = params.page || 1;
    const limit = params.limit || 20;

    const [items, total] = await this.logRepo.findAndCount({
      where: { jobId },
      order: { timestamp: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });

    return { items, total };
  }

  // ============================================================================
  // Dashboard & Stats
  // ============================================================================

  async getJobDashboard(): Promise<JobDashboard> {
    const now = new Date();
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    const [
      totalJobs,
      pendingJobs,
      runningJobs,
      failedJobs,
      completedLast24h,
      recentJobs,
      failedJobsList,
      scheduledJobs,
      queues,
    ] = await Promise.all([
      this.jobRepo.count(),
      this.jobRepo.count({ where: { status: JobStatus.PENDING } }),
      this.jobRepo.count({ where: { status: JobStatus.RUNNING } }),
      this.jobRepo.count({ where: { status: JobStatus.FAILED } }),
      this.jobRepo.count({
        where: {
          status: JobStatus.COMPLETED,
          completedAt: LessThanOrEqual(now),
        },
      }),
      this.jobRepo.find({
        order: { createdAt: 'DESC' },
        take: 10,
      }),
      this.jobRepo.find({
        where: { status: JobStatus.FAILED },
        order: { updatedAt: 'DESC' },
        take: 10,
      }),
      this.jobRepo.find({
        where: { status: In([JobStatus.SCHEDULED, JobStatus.PENDING]) },
        order: { scheduledAt: 'ASC' },
        take: 10,
      }),
      this.queueRepo.find(),
    ]);

    // Calculate average processing time
    const avgResult = await this.jobRepo
      .createQueryBuilder('j')
      .select('AVG(j.durationMs)', 'avg')
      .where('j.status = :status', { status: JobStatus.COMPLETED })
      .andWhere('j.durationMs IS NOT NULL')
      .getRawOne();

    const avgProcessingTime = parseFloat(avgResult?.avg) || 0;

    // Get queue stats
    const queueStats: JobQueueStats[] = [];
    for (const queue of queues) {
      const stats = await this.getQueueStats(queue.name);
      queueStats.push(stats);
    }

    return {
      totalJobs,
      pendingJobs,
      runningJobs,
      failedJobs,
      completedLast24h,
      avgProcessingTime,
      queueStats,
      recentJobs,
      failedJobsList,
      scheduledJobs,
    };
  }

  async getQueueStats(queueName: string): Promise<JobQueueStats> {
    const now = new Date();
    const hourAgo = new Date(now.getTime() - 60 * 60 * 1000);

    const [pending, running, completed, failed, throughputResult, avgTimeResult] =
      await Promise.all([
        this.jobRepo.count({ where: { queueName, status: JobStatus.PENDING } }),
        this.jobRepo.count({ where: { queueName, status: JobStatus.RUNNING } }),
        this.jobRepo.count({ where: { queueName, status: JobStatus.COMPLETED } }),
        this.jobRepo.count({ where: { queueName, status: JobStatus.FAILED } }),
        this.jobRepo
          .createQueryBuilder('j')
          .select('COUNT(*)', 'count')
          .where('j.queueName = :queueName', { queueName })
          .andWhere('j.status = :status', { status: JobStatus.COMPLETED })
          .andWhere('j.completedAt >= :hourAgo', { hourAgo })
          .getRawOne(),
        this.jobRepo
          .createQueryBuilder('j')
          .select('AVG(j.durationMs)', 'avg')
          .where('j.queueName = :queueName', { queueName })
          .andWhere('j.status = :status', { status: JobStatus.COMPLETED })
          .andWhere('j.durationMs IS NOT NULL')
          .getRawOne(),
      ]);

    return {
      queueName,
      pending,
      running,
      completed,
      failed,
      avgProcessingTime: parseFloat(avgTimeResult?.avg) || 0,
      throughput: parseInt(throughputResult?.count, 10) || 0,
    };
  }

  private async updateQueueCounts(queueName: string): Promise<void> {
    const [pending, running, completed, failed] = await Promise.all([
      this.jobRepo.count({ where: { queueName, status: JobStatus.PENDING } }),
      this.jobRepo.count({ where: { queueName, status: JobStatus.RUNNING } }),
      this.jobRepo.count({ where: { queueName, status: JobStatus.COMPLETED } }),
      this.jobRepo.count({ where: { queueName, status: JobStatus.FAILED } }),
    ]);

    await this.queueRepo.update(
      { name: queueName },
      {
        pendingCount: pending,
        runningCount: running,
        completedCount: completed,
        failedCount: failed,
        lastJobAt: new Date(),
      },
    );
  }

  // ============================================================================
  // Bulk Operations
  // ============================================================================

  async retryFailedJobs(queueName?: string): Promise<number> {
    const query = this.jobRepo
      .createQueryBuilder()
      .update()
      .set({
        status: JobStatus.PENDING,
        attempts: 0,
        errorMessage: undefined,
        stackTrace: undefined,
        nextRetryAt: undefined,
      })
      .where('status = :status', { status: JobStatus.FAILED });

    if (queueName) {
      query.andWhere('queueName = :queueName', { queueName });
    }

    const result = await query.execute();
    this.logger.log(`Retried ${result.affected} failed jobs`);
    return result.affected || 0;
  }

  async purgeCompletedJobs(olderThanDays = 7): Promise<number> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - olderThanDays);

    const result = await this.jobRepo.delete({
      status: JobStatus.COMPLETED,
      completedAt: LessThan(cutoff),
    });

    this.logger.log(`Purged ${result.affected} completed jobs older than ${olderThanDays} days`);
    return result.affected || 0;
  }

  @ScheduledJob({ name: 'job-queue.schedule-recurring', cron: CronExpression.EVERY_MINUTE })
  async processScheduledRecurringJobs(): Promise<void> {
    const now = new Date();

    // Find recurring jobs that need to run
    const recurringJobs = await this.jobRepo.find({
      where: {
        isRecurring: true,
        status: JobStatus.SCHEDULED,
        nextRunAt: LessThanOrEqual(now),
        isPaused: false,
      },
    });

    for (const job of recurringJobs) {
      job.status = JobStatus.PENDING;
      await this.jobRepo.save(job);
    }

    if (recurringJobs.length > 0) {
      this.logger.debug(`Triggered ${recurringJobs.length} recurring jobs`);
    }
  }

  @ScheduledJob({ name: 'job-queue.detect-stuck', cron: CronExpression.EVERY_5_MINUTES })
  async detectStuckJobs(): Promise<void> {
    // Find jobs running longer than their timeout
    const stuckJobs = await this.jobRepo
      .createQueryBuilder('j')
      .where('j.status = :status', { status: JobStatus.RUNNING })
      .andWhere('j.startedAt < :cutoff', {
        cutoff: new Date(Date.now() - 2 * 60 * 60 * 1000), // 2 hours
      })
      .getMany();

    for (const job of stuckJobs) {
      this.logger.warn(`Detected stuck job: ${job.name} (${job.id})`);

      job.status = JobStatus.FAILED;
      job.errorMessage = 'Job timed out - detected as stuck';

      if (job.attempts < job.maxAttempts) {
        job.status = JobStatus.RETRYING;
        job.nextRetryAt = new Date(Date.now() + 60000);
      }

      await this.jobRepo.save(job);
    }
  }
}
