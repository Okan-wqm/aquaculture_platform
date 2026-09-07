/**
 * Request bodies for `job-queue.controller.ts` (CONTRACT-CRITICAL-003).
 *
 * DTO classes live in a `*.dto.ts` file, never inside the controller: the
 * `@nestjs/swagger` plugin visits a file EITHER as a controller (typing the
 * responses) or as a model (typing the DTOs), never as both, so a DTO declared
 * beside its routes costs the whole file's response schemas.
 */
import { TenantParam, TenantIdCarrier } from '@aquaculture/backend-common/decorators';
import {
  IsString,
  IsOptional,
  IsNumber,
  IsObject,
  IsArray,
  MaxLength,
  Min,
  Max,
} from 'class-validator';
import { JobType, JobRetryPolicy } from '../../entities/job-queue.entity';

// ============================================================================
// DTOs
// ============================================================================

export class CreateQueueDto {
  @IsString()
  name!: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsNumber()
  concurrency?: number;

  @IsOptional()
  @IsNumber()
  maxJobsPerSecond?: number;

  @IsOptional()
  @IsNumber()
  defaultMaxRetries?: number;

  @IsOptional()
  @IsNumber()
  defaultTimeoutMs?: number;

  @IsOptional()
  @IsObject()
  retryPolicy?: JobRetryPolicy;
}

export class CreateJobDto {
  /** ADMIN-CRITICAL-009: whitelisted carrier key; the verified id arrives through @TenantParam('body'). */
  @TenantIdCarrier()
  readonly tenantId?: undefined;

  @IsString()
  name!: string;

  @IsString()
  queueName!: string;

  @IsOptional()
  @IsString()
  jobType?: JobType;

  @IsOptional()
  @IsNumber()
  priority?: number;

  @IsOptional()
  @IsObject()
  payload?: Record<string, unknown>;

  @IsOptional()
  @IsString()
  scheduledAt?: string;

  @IsOptional()
  @IsString()
  cronExpression?: string;

  @IsOptional()
  @IsNumber()
  timeoutMs?: number;

  @IsOptional()
  @IsNumber()
  maxAttempts?: number;

  @IsOptional()
  @IsObject()
  retryPolicy?: JobRetryPolicy;

  @IsOptional()
  @IsString()
  userId?: string;

  @IsOptional()
  @IsArray()
  dependencies?: string[];

  @IsOptional()
  @IsArray()
  tags?: string[];

  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}

export class UpdateQueueDto {
  @IsOptional()
  @IsString()
  @MaxLength(255)
  description?: string;

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(100)
  concurrency?: number;

  @IsOptional()
  @IsNumber()
  @Min(1)
  maxJobsPerSecond?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  defaultMaxRetries?: number;

  @IsOptional()
  @IsNumber()
  @Min(1000)
  defaultTimeoutMs?: number;

  @IsOptional()
  @IsObject()
  retryPolicy?: JobRetryPolicy;
}

export class ScheduleJobDto {
  /** ADMIN-CRITICAL-009: whitelisted carrier key; the verified id arrives through @TenantParam('body'). */
  @TenantIdCarrier()
  readonly tenantId?: undefined;

  @IsString()
  name!: string;

  @IsString()
  queueName!: string;

  @IsOptional()
  @IsString()
  jobType?: JobType;

  @IsOptional()
  @IsNumber()
  priority?: number;

  @IsOptional()
  @IsObject()
  payload?: Record<string, unknown>;

  @IsString()
  scheduledAt!: string;

  @IsOptional()
  @IsNumber()
  timeoutMs?: number;

  @IsOptional()
  @IsNumber()
  maxAttempts?: number;

  @IsOptional()
  @IsObject()
  retryPolicy?: JobRetryPolicy;

  @IsOptional()
  @IsString()
  userId?: string;

  @IsOptional()
  @IsArray()
  dependencies?: string[];

  @IsOptional()
  @IsArray()
  tags?: string[];

  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}

export class RecurringJobDto {
  /** ADMIN-CRITICAL-009: whitelisted carrier key; the verified id arrives through @TenantParam('body'). */
  @TenantIdCarrier()
  readonly tenantId?: undefined;

  @IsString()
  name!: string;

  @IsString()
  queueName!: string;

  @IsOptional()
  @IsString()
  jobType?: JobType;

  @IsOptional()
  @IsNumber()
  priority?: number;

  @IsOptional()
  @IsObject()
  payload?: Record<string, unknown>;

  @IsString()
  cronExpression!: string;

  @IsOptional()
  @IsNumber()
  timeoutMs?: number;

  @IsOptional()
  @IsNumber()
  maxAttempts?: number;

  @IsOptional()
  @IsObject()
  retryPolicy?: JobRetryPolicy;

  @IsOptional()
  @IsString()
  userId?: string;

  @IsOptional()
  @IsArray()
  dependencies?: string[];

  @IsOptional()
  @IsArray()
  tags?: string[];

  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}

export class RetryFailedJobsDto {
  @IsOptional()
  @IsString()
  @MaxLength(255)
  queueName?: string;
}

export class PurgeCompletedJobsDto {
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(365)
  olderThanDays?: number;
}

export class UpdateJobProgressDto {
  @IsNumber()
  current!: number;

  @IsNumber()
  total!: number;

  @IsNumber()
  percentage!: number;

  @IsOptional()
  @IsString()
  message?: string;

  @IsOptional()
  checkpoint?: unknown;
}
