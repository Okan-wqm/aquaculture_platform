/**
 * Onboarding Controller
 *
 * Tenant onboarding ve eğitim endpoint'leri.
 */

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
import { OnboardingService } from '../services/onboarding.service';
import { OnboardingStatus, TrainingSession } from '../entities/support.entity';

// ============================================================================
// DTOs
// ============================================================================

class InitializeOnboardingDto {
  tenantId: string;
  tenantName: string;
}

class SendWelcomeEmailDto {
  recipientEmail: string;
  recipientName: string;
}

class ScheduleTrainingDto {
  title: string;
  type: 'video_call' | 'webinar' | 'in_person';
  scheduledAt: string;
  duration: number;
  trainer: string;
  meetingUrl?: string;
}

class UpdateTrainingDto {
  status: 'completed' | 'cancelled';
  notes?: string;
}

class AssignGuideDto {
  guideId: string;
  guideName: string;
}

// ============================================================================
// Controller
// ============================================================================

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

  @Post('initialize')
  @HttpCode(HttpStatus.CREATED)
  async initializeOnboarding(@Body() dto: InitializeOnboardingDto) {
    if (!dto.tenantId || !dto.tenantName) {
      throw new BadRequestException('tenantId and tenantName are required');
    }

    return this.onboardingService.initializeOnboarding(dto.tenantId, dto.tenantName);
  }

  @Post(':tenantId/step/:stepId/complete')
  async completeStep(
    @Param('tenantId') tenantId: string,
    @Param('stepId') stepId: string,
  ) {
    return this.onboardingService.completeStep(tenantId, stepId);
  }

  @Post(':tenantId/step/:stepId/skip')
  async skipStep(
    @Param('tenantId') tenantId: string,
    @Param('stepId') stepId: string,
  ) {
    return this.onboardingService.skipStep(tenantId, stepId);
  }

  @Post(':tenantId/skip')
  async skipOnboarding(@Param('tenantId') tenantId: string) {
    return this.onboardingService.skipOnboarding(tenantId);
  }

  // ============================================================================
  // Welcome Email
  // ============================================================================

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

  @Post(':tenantId/tutorials/:tutorialId/view')
  async recordTutorialView(
    @Param('tenantId') tenantId: string,
    @Param('tutorialId') tutorialId: string,
  ) {
    return this.onboardingService.recordTutorialView(tenantId, tutorialId);
  }

  @Post(':tenantId/getting-started/view')
  async recordGettingStartedView(@Param('tenantId') tenantId: string) {
    return this.onboardingService.recordGettingStartedView(tenantId);
  }

  // ============================================================================
  // Training Sessions
  // ============================================================================

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
