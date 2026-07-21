import { BackgroundJob } from '../entities/job-queue.entity';

/**
 * APA-281: single response contract (SSoT) for GET /system/jobs/dashboard.
 *
 * The JobQueuePage consumes `queues` (a management shape carrying isPaused +
 * concurrency, which the lossy per-job `queueStats` projection dropped) and the
 * canonical stat names. The previous return emitted `queueStats`/`failedJobs`
 * that the FE never read, so the Queues tab and the Failed card were blank.
 * `queues` is mapped straight from the persisted JobQueue rows (the real data),
 * not recomputed from jobs.
 */
export interface JobQueueSummaryDto {
  name: string;
  isPaused: boolean;
  concurrency: number;
  pendingCount: number;
  runningCount: number;
  completedCount: number;
  failedCount: number;
}

export interface JobDashboardDto {
  totalJobs: number;
  pendingJobs: number;
  runningJobs: number;
  failedLast24h: number;
  completedLast24h: number;
  avgProcessingTime: number;
  queues: JobQueueSummaryDto[];
  recentJobs: BackgroundJob[];
}
