/**
 * Onboarding Controller
 *
 * Tenant onboarding ve eğitim endpoint'leri.
 */

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
  @IsString()
  tenantId!: string;

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
  async getProgress(@Param('tenantId') tenantId: string) {
    return this.onboardingService.getProgress(tenantId);
  }

  @AuditedOperation({ resource: 'Onboarding', action: 'INITIALIZE_ONBOARDING' })
  @Post('initialize')
  @HttpCode(HttpStatus.CREATED)
  async initializeOnboarding(@Body() dto: InitializeOnboardingDto) {
    if (!dto.tenantId || !dto.tenantName) {
      throw new BadRequestException('tenantId and tenantName are required');
    }

    return this.onboardingService.initializeOnboarding(dto.tenantId, dto.tenantName);
  }

  @AuditedOperation({ resource: 'Step', action: 'COMPLETE' })
  @Post(':tenantId/step/:stepId/complete')
  async completeStep(
    @Param('tenantId') tenantId: string,
    @Param('stepId') stepId: string,
  ) {
    return this.onboardingService.completeStep(tenantId, stepId);
  }

  @AuditedOperation({ resource: 'Onboarding', action: 'SKIP_STEP' })
  @Post(':tenantId/step/:stepId/skip')
  async skipStep(
    @Param('tenantId') tenantId: string,
    @Param('stepId') stepId: string,
  ) {
    return this.onboardingService.skipStep(tenantId, stepId);
  }

  @AuditedOperation({ resource: 'Onboarding', action: 'SKIP_ONBOARDING' })
  @Post(':tenantId/skip')
  async skipOnboarding(@Param('tenantId') tenantId: string) {
    return this.onboardingService.skipOnboarding(tenantId);
  }

  // ============================================================================
  // Welcome Email
  // ============================================================================

  @AuditedOperation({ resource: 'WelcomeEmail', action: 'SEND' })
  @Post(':tenantId/welcome-email')
  async sendWelcomeEmail(
    @Param('tenantId') tenantId: string,
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
  @Post(':tenantId/tutorials/:tutorialId/view')
  async recordTutorialView(
    @Param('tenantId') tenantId: string,
    @Param('tutorialId') tutorialId: string,
  ) {
    return this.onboardingService.recordTutorialView(tenantId, tutorialId);
  }

  @AuditedOperation({ resource: 'GettingStartedView', action: 'RECORD' })
  @Post(':tenantId/getting-started/view')
  async recordGettingStartedView(@Param('tenantId') tenantId: string) {
    return this.onboardingService.recordGettingStartedView(tenantId);
  }

  // ============================================================================
  // Training Sessions
  // ============================================================================

  @AuditedOperation({ resource: 'Onboarding', action: 'SCHEDULE_TRAINING' })
  @Post(':tenantId/training')
  @HttpCode(HttpStatus.CREATED)
  async scheduleTraining(
    @Param('tenantId') tenantId: string,
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
  @Put(':tenantId/training/:sessionId')
  async updateTraining(
    @Param('tenantId') tenantId: string,
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
  @Post(':tenantId/assign-guide')
  async assignGuide(
    @Param('tenantId') tenantId: string,
    @Body() dto: AssignGuideDto,
  ) {
    if (!dto.guideId || !dto.guideName) {
      throw new BadRequestException('guideId and guideName are required');
    }

    return this.onboardingService.assignGuide(tenantId, dto.guideId, dto.guideName);
  }
}
