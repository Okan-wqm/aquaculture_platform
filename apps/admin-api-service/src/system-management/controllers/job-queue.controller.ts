import {
  CreateJobDto,
  CreateQueueDto,
  PurgeCompletedJobsDto,
  RecurringJobDto,
  RetryFailedJobsDto,
  ScheduleJobDto,
  UpdateJobProgressDto,
  UpdateQueueDto,
} from './dto/job-queue.dto';
import { Destructive, RequiresCapability, TenantParam, TenantIdCarrier } from '@aquaculture/backend-common/decorators';
import { AuditedOperation } from '@aquaculture/backend-common/audit';
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

import { IsString, IsOptional, IsNumber, IsObject, IsArray, MaxLength, Min, Max } from 'class-validator';

import { JobStatus, JobType, JobPriority, JobRetryPolicy } from '../entities/job-queue.entity';
import { JobQueueService, JobDefinition } from '../services/job-queue.service';

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

  @Get('dashboard')
  async getJobDashboard() {
    return this.jobQueueService.getJobDashboard();
  }

  // ============================================================================
  // Queue Management
  // ============================================================================

  @AuditedOperation({ resource: 'Queue', action: 'CREATE' })
  @RequiresCapability('security-ops')
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

  @AuditedOperation({ resource: 'Queue', action: 'UPDATE' })
  @RequiresCapability('security-ops')
  @Put('queues/:name')
  async updateQueue(@Param('name') name: string, @Body() dto: UpdateQueueDto) {
    return this.jobQueueService.updateQueue(name, dto);
  }

  @AuditedOperation({ resource: 'Queue', action: 'PAUSE' })
  @RequiresCapability('security-ops')
  @Post('queues/:name/pause')
  async pauseQueue(@Param('name') name: string) {
    return this.jobQueueService.pauseQueue(name);
  }

  @AuditedOperation({ resource: 'Queue', action: 'RESUME' })
  @RequiresCapability('security-ops')
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

  @AuditedOperation({ resource: 'Job', action: 'CREATE' })
  @RequiresCapability('security-ops')
  @Post()
  async createJob(@Body() dto: CreateJobDto) {
    const definition: JobDefinition = {
      ...dto,
      scheduledAt: dto.scheduledAt ? new Date(dto.scheduledAt) : undefined,
    };
    return this.jobQueueService.createJob(definition);
  }

  @AuditedOperation({ resource: 'JobQueue', action: 'SCHEDULE_JOB' })
  @RequiresCapability('security-ops')
  @Post('schedule')
  async scheduleJob(
    @TenantParam('body', { optional: true, allow: 'any' }) tenantId: string | undefined,
    @Body() dto: ScheduleJobDto,
  ) {
    const { scheduledAt: scheduledAtStr, ...rest } = { ...dto, tenantId };
    const definition: JobDefinition = rest;
    return this.jobQueueService.scheduleJob(definition, new Date(scheduledAtStr));
  }

  @AuditedOperation({ resource: 'JobQueue', action: 'SCHEDULE_RECURRING_JOB' })
  @RequiresCapability('security-ops')
  @Post('recurring')
  async scheduleRecurringJob(
    @TenantParam('body', { optional: true, allow: 'any' }) tenantId: string | undefined,
    @Body() dto: RecurringJobDto,
  ) {
    const { cronExpression, ...rest } = { ...dto, tenantId };
    const definition: JobDefinition = rest;
    return this.jobQueueService.scheduleRecurringJob(definition, cronExpression);
  }

  @Get()
  async queryJobs(
    @Query('queueName') queueName?: string,
    @Query('status') status?: JobStatus,
    @Query('jobType') jobType?: JobType,
    @TenantParam('query', { optional: true }) tenantId?: string,
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

  @AuditedOperation({ resource: 'Job', action: 'CANCEL' })
  @RequiresCapability('security-ops')
  @Post(':id/cancel')
  async cancelJob(@Param('id') id: string) {
    return this.jobQueueService.cancelJob(id);
  }

  @AuditedOperation({ resource: 'Job', action: 'RETRY' })
  @RequiresCapability('security-ops')
  @Post(':id/retry')
  async retryJob(@Param('id') id: string) {
    return this.jobQueueService.retryJob(id);
  }

  @AuditedOperation({ resource: 'Job', action: 'PAUSE' })
  @RequiresCapability('security-ops')
  @Post(':id/pause')
  async pauseJob(@Param('id') id: string) {
    return this.jobQueueService.pauseJob(id);
  }

  @AuditedOperation({ resource: 'Job', action: 'RESUME' })
  @RequiresCapability('security-ops')
  @Post(':id/resume')
  async resumeJob(@Param('id') id: string) {
    return this.jobQueueService.resumeJob(id);
  }

  @AuditedOperation({ resource: 'JobProgress', action: 'UPDATE' })
  @RequiresCapability('security-ops')
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

  @AuditedOperation({ resource: 'FailedJobs', action: 'RETRY' })
  @RequiresCapability('security-ops')
  @Post('retry-failed')
  async retryFailedJobs(@Body() dto: RetryFailedJobsDto) {
    const count = await this.jobQueueService.retryFailedJobs(dto.queueName);
    return { retriedCount: count };
  }

  @AuditedOperation({ resource: 'CompletedJobs', action: 'PURGE' })
  @Destructive()
  @RequiresCapability('security-ops')
  @Post('purge-completed')
  async purgeCompletedJobs(@Body() dto: PurgeCompletedJobsDto) {
    const count = await this.jobQueueService.purgeCompletedJobs(dto.olderThanDays);
    return { purgedCount: count };
  }
}
