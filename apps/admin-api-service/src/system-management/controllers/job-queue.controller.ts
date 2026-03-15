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
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { IsString, IsOptional, IsNumber, IsObject, IsArray } from 'class-validator';

import { PlatformAdminGuard } from '../../guards/platform-admin.guard';

import { JobStatus, JobType, JobPriority, JobRetryPolicy } from '../entities/job-queue.entity';
import { JobQueueService, JobDefinition } from '../services/job-queue.service';

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
@UseGuards(PlatformAdminGuard) // H14 fix: explicit guard
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
