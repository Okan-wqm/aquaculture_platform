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

import { JobQueueService, JobDefinition } from '../services/job-queue.service';
import { JobStatus, JobType, JobPriority, JobRetryPolicy } from '../entities/job-queue.entity';

// ============================================================================
// DTOs
// ============================================================================

class CreateQueueDto {
  name: string;
  description?: string;
  concurrency?: number;
  maxJobsPerSecond?: number;
  defaultMaxRetries?: number;
  defaultTimeoutMs?: number;
  retryPolicy?: JobRetryPolicy;
}

class CreateJobDto {
  name: string;
  queueName: string;
  jobType?: JobType;
  priority?: number;
  payload?: Record<string, unknown>;
  scheduledAt?: string;
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

class UpdateJobProgressDto {
  current: number;
  total: number;
  percentage: number;
  message?: string;
  checkpoint?: unknown;
}

// ============================================================================
// Controller
// ============================================================================

@Controller('system/jobs')
export class JobQueueController {
  constructor(private readonly jobQueueService: JobQueueService) {}

  // ============================================================================
  // Dashboard
  // ============================================================================

  @Get('dashboard')
  async getJobDashboard() {
    return this.jobQueueService.getJobDashboard();
  }

  // ============================================================================
  // Queue Management
  // ============================================================================

  @Post('queues')
  async createQueue(@Body() dto: CreateQueueDto) {
    return this.jobQueueService.createQueue(dto);
  }

  @Get('queues')
  async getAllQueues() {
    return this.jobQueueService.getAllQueues();
  }

  @Get('queues/:name')
  async getQueue(@Param('name') name: string) {
    return this.jobQueueService.getQueue(name);
  }

  @Put('queues/:name')
  async updateQueue(@Param('name') name: string, @Body() dto: Partial<CreateQueueDto>) {
    return this.jobQueueService.updateQueue(name, dto);
  }

  @Post('queues/:name/pause')
  async pauseQueue(@Param('name') name: string) {
    return this.jobQueueService.pauseQueue(name);
  }

  @Post('queues/:name/resume')
  async resumeQueue(@Param('name') name: string) {
    return this.jobQueueService.resumeQueue(name);
  }

  @Get('queues/:name/stats')
  async getQueueStats(@Param('name') name: string) {
    return this.jobQueueService.getQueueStats(name);
  }

  // ============================================================================
  // Job Management
  // ============================================================================

  @Post()
  async createJob(@Body() dto: CreateJobDto) {
    const definition: JobDefinition = {
      ...dto,
      scheduledAt: dto.scheduledAt ? new Date(dto.scheduledAt) : undefined,
    };
    return this.jobQueueService.createJob(definition);
  }

  @Post('schedule')
  async scheduleJob(
    @Body() dto: CreateJobDto & { scheduledAt: string },
  ) {
    const { scheduledAt: scheduledAtStr, cronExpression: _cron, ...rest } = dto;
    const definition: JobDefinition = rest;
    return this.jobQueueService.scheduleJob(definition, new Date(scheduledAtStr));
  }

  @Post('recurring')
  async scheduleRecurringJob(
    @Body() dto: CreateJobDto & { cronExpression: string },
  ) {
    const { cronExpression, scheduledAt: _scheduled, ...rest } = dto;
    const definition: JobDefinition = rest;
    return this.jobQueueService.scheduleRecurringJob(definition, cronExpression);
  }

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
  ) {
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

  @Get(':id')
  async getJob(@Param('id') id: string) {
    return this.jobQueueService.getJob(id);
  }

  @Post(':id/cancel')
  async cancelJob(@Param('id') id: string) {
    return this.jobQueueService.cancelJob(id);
  }

  @Post(':id/retry')
  async retryJob(@Param('id') id: string) {
    return this.jobQueueService.retryJob(id);
  }

  @Post(':id/pause')
  async pauseJob(@Param('id') id: string) {
    return this.jobQueueService.pauseJob(id);
  }

  @Post(':id/resume')
  async resumeJob(@Param('id') id: string) {
    return this.jobQueueService.resumeJob(id);
  }

  @Put(':id/progress')
  async updateJobProgress(
    @Param('id') id: string,
    @Body() dto: UpdateJobProgressDto,
  ) {
    return this.jobQueueService.updateJobProgress(id, dto);
  }

  // ============================================================================
  // Job Execution Logs
  // ============================================================================

  @Get(':id/logs')
  async getJobLogs(
    @Param('id') id: string,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ) {
    return this.jobQueueService.getJobLogs(id, {
      page: page ? Number(page) : undefined,
      limit: limit ? Number(limit) : undefined,
    });
  }

  // ============================================================================
  // Bulk Operations
  // ============================================================================

  @Post('retry-failed')
  async retryFailedJobs(@Body() dto: { queueName?: string }) {
    const count = await this.jobQueueService.retryFailedJobs(dto.queueName);
    return { retriedCount: count };
  }

  @Post('purge-completed')
  async purgeCompletedJobs(@Body() dto: { olderThanDays?: number }) {
    const count = await this.jobQueueService.purgeCompletedJobs(dto.olderThanDays);
    return { purgedCount: count };
  }
}
