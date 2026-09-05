/**
 * Onboarding Controller
 *
 * Tenant onboarding ve eğitim endpoint'leri.
 */

import { RequiresCapability, TenantParam, TenantIdCarrier } from '@aquaculture/backend-common/decorators';
import { AuditedOperation } from '@aquaculture/backend-common/audit';
import {
  Controller,
  Get,
  Post,
  Put,
  Param,
  Body,
  Query,
  HttpStatus,
  HttpCode,
  BadRequestException,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { IsString, IsOptional, IsNumber, IsIn } from 'class-validator';

import { OnboardingStatus, TrainingSession } from '../entities/support.entity';
import { OnboardingService } from '../services/onboarding.service';

// ============================================================================
// DTOs
// ============================================================================

class InitializeOnboardingDto {
  /** ADMIN-CRITICAL-009: whitelisted carrier key; the verified id arrives through @TenantParam('body'). */
  @TenantIdCarrier()
  readonly tenantId?: undefined;


  @IsString()
  tenantName!: string;
}

class SendWelcomeEmailDto {
  @IsString()
  recipientEmail!: string;

  @IsString()
  recipientName!: string;
}

class ScheduleTrainingDto {
  @IsString()
  title!: string;

  @IsIn(['video_call', 'webinar', 'in_person'])
  type!: 'video_call' | 'webinar' | 'in_person';

  @IsString()
  scheduledAt!: string;

  @IsNumber()
  duration!: number;

  @IsString()
  trainer!: string;

  @IsOptional()
  @IsString()
  meetingUrl?: string;
}

class UpdateTrainingDto {
  @IsIn(['completed', 'cancelled'])
  status!: 'completed' | 'cancelled';

  @IsOptional()
  @IsString()
  notes?: string;
}

class AssignGuideDto {
  @IsString()
  guideId!: string;

  @IsString()
  guideName!: string;
}

// ============================================================================
// Controller
// ============================================================================

@ApiTags('Support')
@Controller('support/onboarding')
export class OnboardingController {
  constructor(private readonly onboardingService: OnboardingService) {}

  // ============================================================================
  // Progress Management
  // ============================================================================

  @Get()
  async getAllProgress(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('status') status?: OnboardingStatus,
  ) {
    return this.onboardingService.getAllProgress({
      page: page ? parseInt(page, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
      status,
    });
  }

  @Get('stats')
  async getStats() {
    return this.onboardingService.getOnboardingStats();
  }

  @Get('steps')
  getOnboardingSteps() {
    return this.onboardingService.getOnboardingSteps();
  }

  @Get('needs-attention')
  async getTenantsNeedingAttention() {
    return this.onboardingService.getTenantsNeedingAttention();
  }

  @Get(':tenantId')
  async getProgress(@TenantParam('param', { allow: 'any' }) tenantId: string) {
    return this.onboardingService.getProgress(tenantId);
  }

  @AuditedOperation({ resource: 'Onboarding', action: 'INITIALIZE_ONBOARDING' })
  @RequiresCapability('support-ops')
  @Post('initialize')
  @HttpCode(HttpStatus.CREATED)
  async initializeOnboarding(@TenantParam('body', { allow: 'any' }) tenantId: string, @Body() dto: InitializeOnboardingDto) {
    if (!tenantId || !dto.tenantName) {
      throw new BadRequestException('tenantId and tenantName are required');
    }

    return this.onboardingService.initializeOnboarding(tenantId, dto.tenantName);
  }

  @AuditedOperation({ resource: 'Step', action: 'COMPLETE' })
  @RequiresCapability('support-ops')
  @Post(':tenantId/step/:stepId/complete')
  async completeStep(
    @TenantParam('param', { allow: 'any' }) tenantId: string,
    @Param('stepId') stepId: string,
  ) {
    return this.onboardingService.completeStep(tenantId, stepId);
  }

  @AuditedOperation({ resource: 'Onboarding', action: 'SKIP_STEP' })
  @RequiresCapability('support-ops')
  @Post(':tenantId/step/:stepId/skip')
  async skipStep(
    @TenantParam('param', { allow: 'any' }) tenantId: string,
    @Param('stepId') stepId: string,
  ) {
    return this.onboardingService.skipStep(tenantId, stepId);
  }

  @AuditedOperation({ resource: 'Onboarding', action: 'SKIP_ONBOARDING' })
  @RequiresCapability('support-ops')
  @Post(':tenantId/skip')
  async skipOnboarding(@TenantParam('param', { allow: 'any' }) tenantId: string) {
    return this.onboardingService.skipOnboarding(tenantId);
  }

  // ============================================================================
  // Welcome Email
  // ============================================================================

  @AuditedOperation({ resource: 'WelcomeEmail', action: 'SEND' })
  @RequiresCapability('support-ops')
  @Post(':tenantId/welcome-email')
  async sendWelcomeEmail(
    @TenantParam('param', { allow: 'any' }) tenantId: string,
    @Body() dto: SendWelcomeEmailDto,
  ) {
    if (!dto.recipientEmail || !dto.recipientName) {
      throw new BadRequestException('recipientEmail and recipientName are required');
    }

    await this.onboardingService.sendWelcomeEmail(
      tenantId,
      dto.recipientEmail,
      dto.recipientName,
    );

    return { success: true, message: 'Welcome email sent' };
  }

  // ============================================================================
  // Training Resources
  // ============================================================================

  @Get('resources/all')
  getTrainingResources(@Query('category') category?: string) {
    return this.onboardingService.getTrainingResources(category);
  }

  @AuditedOperation({ resource: 'TutorialView', action: 'RECORD' })
  @RequiresCapability('support-ops')
  @Post(':tenantId/tutorials/:tutorialId/view')
  async recordTutorialView(
    @TenantParam('param', { allow: 'any' }) tenantId: string,
    @Param('tutorialId') tutorialId: string,
  ) {
    return this.onboardingService.recordTutorialView(tenantId, tutorialId);
  }

  @AuditedOperation({ resource: 'GettingStartedView', action: 'RECORD' })
  @RequiresCapability('support-ops')
  @Post(':tenantId/getting-started/view')
  async recordGettingStartedView(@TenantParam('param', { allow: 'any' }) tenantId: string) {
    return this.onboardingService.recordGettingStartedView(tenantId);
  }

  // ============================================================================
  // Training Sessions
  // ============================================================================

  @AuditedOperation({ resource: 'Onboarding', action: 'SCHEDULE_TRAINING' })
  @RequiresCapability('support-ops')
  @Post(':tenantId/training')
  @HttpCode(HttpStatus.CREATED)
  async scheduleTraining(
    @TenantParam('param', { allow: 'any' }) tenantId: string,
    @Body() dto: ScheduleTrainingDto,
  ) {
    if (!dto.title || !dto.type || !dto.scheduledAt || !dto.trainer) {
      throw new BadRequestException('title, type, scheduledAt, and trainer are required');
    }

    return this.onboardingService.scheduleTrainingSession(tenantId, {
      title: dto.title,
      type: dto.type,
      scheduledAt: dto.scheduledAt,
      duration: dto.duration || 60,
      trainer: dto.trainer,
      meetingUrl: dto.meetingUrl,
    });
  }

  @AuditedOperation({ resource: 'Training', action: 'UPDATE' })
  @RequiresCapability('support-ops')
  @Put(':tenantId/training/:sessionId')
  async updateTraining(
    @TenantParam('param', { allow: 'any' }) tenantId: string,
    @Param('sessionId') sessionId: string,
    @Body() dto: UpdateTrainingDto,
  ) {
    if (!dto.status) {
      throw new BadRequestException('status is required');
    }

    return this.onboardingService.updateTrainingSession(
      tenantId,
      sessionId,
      dto.status,
      dto.notes,
    );
  }

  // ============================================================================
  // Guide Assignment
  // ============================================================================

  @AuditedOperation({ resource: 'Guide', action: 'ASSIGN' })
  @RequiresCapability('support-ops')
  @Post(':tenantId/assign-guide')
  async assignGuide(
    @TenantParam('param', { allow: 'any' }) tenantId: string,
    @Body() dto: AssignGuideDto,
  ) {
    if (!dto.guideId || !dto.guideName) {
      throw new BadRequestException('guideId and guideName are required');
    }

    return this.onboardingService.assignGuide(tenantId, dto.guideId, dto.guideName);
  }
}
