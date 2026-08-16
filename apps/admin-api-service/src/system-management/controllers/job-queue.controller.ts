import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

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

import { JobStatus, JobType, JobPriority, JobRetryPolicy } from '../entities/job-queue.entity';
import { JobQueueService, JobDefinition } from '../services/job-queue.service';
import {
  AdminQueryEncoding,
  AdminResponseContract,
} from '../../shared/admin-response-contract.decorator';
import {
  jobQueueJobDashboardContract,
  type JobQueueJobDashboardDto,
  jobQueueJobQueueContract,
  type JobQueueJobQueueDto,
  jobQueueJobQueueArrayContract,
  jobQueueJobQueueStatsContract,
  type JobQueueJobQueueStatsDto,
  jobQueueBackgroundJobContract,
  type JobQueueBackgroundJobDto,
  jobQueueQueryJobsResponseContract,
  type JobQueueQueryJobsResponseDto,
  jobQueueGetJobLogsResponseContract,
  type JobQueueGetJobLogsResponseDto,
  jobQueueRetryFailedJobsResponseContract,
  type JobQueueRetryFailedJobsResponseDto,
  jobQueuePurgeCompletedJobsResponseContract,
  type JobQueuePurgeCompletedJobsResponseDto,
} from '../contracts/admin-http-response.contract';

// ============================================================================
// DTOs
// ============================================================================

class CreateQueueDto {
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

class CreateJobDto {
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
  tenantId?: string;

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

class UpdateQueueDto {
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

class ScheduleJobDto {
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
  tenantId?: string;

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

class RecurringJobDto {
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
  tenantId?: string;

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

class RetryFailedJobsDto {
  @IsOptional()
  @IsString()
  @MaxLength(255)
  queueName?: string;
}

class PurgeCompletedJobsDto {
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(365)
  olderThanDays?: number;
}

class UpdateJobProgressDto {
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

// ============================================================================
// Controller
// ============================================================================

@ApiTags('Analytics')
@Controller('system/jobs')
export class JobQueueController {
  constructor(private readonly jobQueueService: JobQueueService) {}

  // ============================================================================
  // Dashboard
  // ============================================================================

  @AdminResponseContract(jobQueueJobDashboardContract)
  @Get('dashboard')
  async getJobDashboard(): Promise<JobQueueJobDashboardDto> {
    return this.jobQueueService.getJobDashboard();
  }

  // ============================================================================
  // Queue Management
  // ============================================================================

  @AdminResponseContract(jobQueueJobQueueContract)
  @Post('queues')
  async createQueue(@Body() dto: CreateQueueDto): Promise<JobQueueJobQueueDto> {
    return this.jobQueueService.createQueue(dto);
  }

  @AdminResponseContract(jobQueueJobQueueArrayContract)
  @Get('queues')
  async getAllQueues(): Promise<JobQueueJobQueueDto[]> {
    return this.jobQueueService.getAllQueues();
  }

  @AdminResponseContract(jobQueueJobQueueContract)
  @Get('queues/:name')
  async getQueue(@Param('name') name: string): Promise<JobQueueJobQueueDto> {
    return this.jobQueueService.getQueue(name);
  }

  @AdminResponseContract(jobQueueJobQueueContract)
  @Put('queues/:name')
  async updateQueue(
    @Param('name') name: string,
    @Body() dto: UpdateQueueDto,
  ): Promise<JobQueueJobQueueDto> {
    return this.jobQueueService.updateQueue(name, dto);
  }

  @AdminResponseContract(jobQueueJobQueueContract)
  @Post('queues/:name/pause')
  async pauseQueue(@Param('name') name: string): Promise<JobQueueJobQueueDto> {
    return this.jobQueueService.pauseQueue(name);
  }

  @AdminResponseContract(jobQueueJobQueueContract)
  @Post('queues/:name/resume')
  async resumeQueue(@Param('name') name: string): Promise<JobQueueJobQueueDto> {
    return this.jobQueueService.resumeQueue(name);
  }

  @AdminResponseContract(jobQueueJobQueueStatsContract)
  @Get('queues/:name/stats')
  async getQueueStats(@Param('name') name: string): Promise<JobQueueJobQueueStatsDto> {
    return this.jobQueueService.getQueueStats(name);
  }

  // ============================================================================
  // Job Management
  // ============================================================================

  @AdminResponseContract(jobQueueBackgroundJobContract)
  @Post()
  async createJob(@Body() dto: CreateJobDto): Promise<JobQueueBackgroundJobDto> {
    const definition: JobDefinition = {
      ...dto,
      scheduledAt: dto.scheduledAt ? new Date(dto.scheduledAt) : undefined,
    };
    return this.jobQueueService.createJob(definition);
  }

  @AdminResponseContract(jobQueueBackgroundJobContract)
  @Post('schedule')
  async scheduleJob(@Body() dto: ScheduleJobDto): Promise<JobQueueBackgroundJobDto> {
    const { scheduledAt: scheduledAtStr, ...rest } = dto;
    const definition: JobDefinition = rest;
    return this.jobQueueService.scheduleJob(definition, new Date(scheduledAtStr));
  }

  @AdminResponseContract(jobQueueBackgroundJobContract)
  @Post('recurring')
  async scheduleRecurringJob(@Body() dto: RecurringJobDto): Promise<JobQueueBackgroundJobDto> {
    const { cronExpression, ...rest } = dto;
    const definition: JobDefinition = rest;
    return this.jobQueueService.scheduleRecurringJob(definition, cronExpression);
  }

  @AdminResponseContract(jobQueueQueryJobsResponseContract)
  @AdminQueryEncoding({ tags: 'comma-separated' })
  @Get()
  async queryJobs(
    @Query('queueName') queueName?: string,
    @Query('status') status?: JobStatus,
    @Query('jobType') jobType?: JobType,
    @Query('tenantId') tenantId?: string,
    @Query('tags') tags?: string,
    @Query('search') search?: string,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ): Promise<JobQueueQueryJobsResponseDto> {
    return this.jobQueueService.queryJobs({
      queueName,
      status,
      jobType,
      tenantId,
      tags: tags ? tags.split(',') : undefined,
      search,
      page: page ? Number(page) : undefined,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @AdminResponseContract(jobQueueBackgroundJobContract)
  @Get(':id')
  async getJob(@Param('id') id: string): Promise<JobQueueBackgroundJobDto> {
    return this.jobQueueService.getJob(id);
  }

  @AdminResponseContract(jobQueueBackgroundJobContract)
  @Post(':id/cancel')
  async cancelJob(@Param('id') id: string): Promise<JobQueueBackgroundJobDto> {
    return this.jobQueueService.cancelJob(id);
  }

  @AdminResponseContract(jobQueueBackgroundJobContract)
  @Post(':id/retry')
  async retryJob(@Param('id') id: string): Promise<JobQueueBackgroundJobDto> {
    return this.jobQueueService.retryJob(id);
  }

  @AdminResponseContract(jobQueueBackgroundJobContract)
  @Post(':id/pause')
  async pauseJob(@Param('id') id: string): Promise<JobQueueBackgroundJobDto> {
    return this.jobQueueService.pauseJob(id);
  }

  @AdminResponseContract(jobQueueBackgroundJobContract)
  @Post(':id/resume')
  async resumeJob(@Param('id') id: string): Promise<JobQueueBackgroundJobDto> {
    return this.jobQueueService.resumeJob(id);
  }

  @AdminResponseContract(jobQueueBackgroundJobContract)
  @Put('by-id/:id/progress')
  async updateJobProgress(
    @Param('id') id: string,
    @Body() dto: UpdateJobProgressDto,
  ): Promise<JobQueueBackgroundJobDto> {
    return this.jobQueueService.updateJobProgress(id, dto);
  }

  // ============================================================================
  // Job Execution Logs
  // ============================================================================

  @AdminResponseContract(jobQueueGetJobLogsResponseContract)
  @Get('by-id/:id/logs')
  async getJobLogs(
    @Param('id') id: string,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ): Promise<JobQueueGetJobLogsResponseDto> {
    return this.jobQueueService.getJobLogs(id, {
      page: page ? Number(page) : undefined,
      limit: limit ? Number(limit) : undefined,
    });
  }

  // ============================================================================
  // Bulk Operations
  // ============================================================================

  @AdminResponseContract(jobQueueRetryFailedJobsResponseContract)
  @Post('retry-failed')
  async retryFailedJobs(
    @Body() dto: RetryFailedJobsDto,
  ): Promise<JobQueueRetryFailedJobsResponseDto> {
    const count = await this.jobQueueService.retryFailedJobs(dto.queueName);
    return { retriedCount: count };
  }

  @AdminResponseContract(jobQueuePurgeCompletedJobsResponseContract)
  @Post('purge-completed')
  async purgeCompletedJobs(
    @Body() dto: PurgeCompletedJobsDto,
  ): Promise<JobQueuePurgeCompletedJobsResponseDto> {
    const count = await this.jobQueueService.purgeCompletedJobs(dto.olderThanDays);
    return { purgedCount: count };
  }
}
