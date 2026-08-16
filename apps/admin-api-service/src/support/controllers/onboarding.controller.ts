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
import { ApiTags } from '@nestjs/swagger';

import { IsString, IsOptional, IsNumber, IsIn, IsUUID } from 'class-validator';

import { OnboardingStatus, TrainingSession } from '../entities/support.entity';
import { OnboardingService } from '../services/onboarding.service';
import type { IStandardPaginatedResult } from '@aquaculture/backend-common/pagination';
import { AdminResponseContract } from '../../shared/admin-response-contract.decorator';
import {
  onboardingOnboardingProgressPageContract,
  type OnboardingOnboardingProgressDto,
  onboardingGetStatsResponseContract,
  type OnboardingGetStatsResponseDto,
  onboardingOnboardingStepArrayContract,
  type OnboardingOnboardingStepDto,
  onboardingOnboardingProgressArrayContract,
  onboardingOnboardingProgressContract,
  onboardingSendWelcomeEmailResponseContract,
  type OnboardingSendWelcomeEmailResponseDto,
  onboardingTrainingResourceArrayContract,
  type OnboardingTrainingResourceDto,
} from '../contracts/admin-http-response.contract';

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
  @IsUUID()
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

  @AdminResponseContract(onboardingOnboardingProgressPageContract)
  @Get()
  async getAllProgress(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('status') status?: OnboardingStatus,
  ): Promise<IStandardPaginatedResult<OnboardingOnboardingProgressDto>> {
    return this.onboardingService.getAllProgress({
      page: page ? parseInt(page, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
      status,
    });
  }

  @AdminResponseContract(onboardingGetStatsResponseContract)
  @Get('stats')
  async getStats(): Promise<OnboardingGetStatsResponseDto> {
    return this.onboardingService.getOnboardingStats();
  }

  @AdminResponseContract(onboardingOnboardingStepArrayContract)
  @Get('steps')
  getOnboardingSteps(): OnboardingOnboardingStepDto[] {
    return this.onboardingService.getOnboardingSteps();
  }

  @AdminResponseContract(onboardingOnboardingProgressArrayContract)
  @Get('needs-attention')
  async getTenantsNeedingAttention(): Promise<OnboardingOnboardingProgressDto[]> {
    return this.onboardingService.getTenantsNeedingAttention();
  }

  @AdminResponseContract(onboardingOnboardingProgressContract)
  @Get(':tenantId')
  async getProgress(@Param('tenantId') tenantId: string): Promise<OnboardingOnboardingProgressDto> {
    return this.onboardingService.getProgress(tenantId);
  }

  @AdminResponseContract(onboardingOnboardingProgressContract)
  @Post('initialize')
  @HttpCode(HttpStatus.CREATED)
  async initializeOnboarding(
    @Body() dto: InitializeOnboardingDto,
  ): Promise<OnboardingOnboardingProgressDto> {
    if (!dto.tenantId || !dto.tenantName) {
      throw new BadRequestException('tenantId and tenantName are required');
    }

    return this.onboardingService.initializeOnboarding(dto.tenantId, dto.tenantName);
  }

  @AdminResponseContract(onboardingOnboardingProgressContract)
  @Post(':tenantId/step/:stepId/complete')
  async completeStep(
    @Param('tenantId') tenantId: string,
    @Param('stepId') stepId: string,
  ): Promise<OnboardingOnboardingProgressDto> {
    return this.onboardingService.completeStep(tenantId, stepId);
  }

  @AdminResponseContract(onboardingOnboardingProgressContract)
  @Post(':tenantId/step/:stepId/skip')
  async skipStep(
    @Param('tenantId') tenantId: string,
    @Param('stepId') stepId: string,
  ): Promise<OnboardingOnboardingProgressDto> {
    return this.onboardingService.skipStep(tenantId, stepId);
  }

  @AdminResponseContract(onboardingOnboardingProgressContract)
  @Post(':tenantId/skip')
  async skipOnboarding(
    @Param('tenantId') tenantId: string,
  ): Promise<OnboardingOnboardingProgressDto> {
    return this.onboardingService.skipOnboarding(tenantId);
  }

  // ============================================================================
  // Welcome Email
  // ============================================================================

  @AdminResponseContract(onboardingSendWelcomeEmailResponseContract)
  @Post(':tenantId/welcome-email')
  async sendWelcomeEmail(
    @Param('tenantId') tenantId: string,
    @Body() dto: SendWelcomeEmailDto,
  ): Promise<OnboardingSendWelcomeEmailResponseDto> {
    if (!dto.recipientEmail || !dto.recipientName) {
      throw new BadRequestException('recipientEmail and recipientName are required');
    }

    await this.onboardingService.sendWelcomeEmail(tenantId, dto.recipientEmail, dto.recipientName);

    return { success: true, message: 'Welcome email sent' };
  }

  // ============================================================================
  // Training Resources
  // ============================================================================

  @AdminResponseContract(onboardingTrainingResourceArrayContract)
  @Get('resources/all')
  getTrainingResources(@Query('category') category?: string): OnboardingTrainingResourceDto[] {
    return this.onboardingService.getTrainingResources(category);
  }

  @AdminResponseContract(onboardingOnboardingProgressContract)
  @Post(':tenantId/tutorials/:tutorialId/view')
  async recordTutorialView(
    @Param('tenantId') tenantId: string,
    @Param('tutorialId') tutorialId: string,
  ): Promise<OnboardingOnboardingProgressDto> {
    return this.onboardingService.recordTutorialView(tenantId, tutorialId);
  }

  @AdminResponseContract(onboardingOnboardingProgressContract)
  @Post(':tenantId/getting-started/view')
  async recordGettingStartedView(
    @Param('tenantId') tenantId: string,
  ): Promise<OnboardingOnboardingProgressDto> {
    return this.onboardingService.recordGettingStartedView(tenantId);
  }

  // ============================================================================
  // Training Sessions
  // ============================================================================

  @AdminResponseContract(onboardingOnboardingProgressContract)
  @Post(':tenantId/training')
  @HttpCode(HttpStatus.CREATED)
  async scheduleTraining(
    @Param('tenantId') tenantId: string,
    @Body() dto: ScheduleTrainingDto,
  ): Promise<OnboardingOnboardingProgressDto> {
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

  @AdminResponseContract(onboardingOnboardingProgressContract)
  @Put(':tenantId/training/:sessionId')
  async updateTraining(
    @Param('tenantId') tenantId: string,
    @Param('sessionId') sessionId: string,
    @Body() dto: UpdateTrainingDto,
  ): Promise<OnboardingOnboardingProgressDto> {
    if (!dto.status) {
      throw new BadRequestException('status is required');
    }

    return this.onboardingService.updateTrainingSession(tenantId, sessionId, dto.status, dto.notes);
  }

  // ============================================================================
  // Guide Assignment
  // ============================================================================

  @AdminResponseContract(onboardingOnboardingProgressContract)
  @Post(':tenantId/assign-guide')
  async assignGuide(
    @Param('tenantId') tenantId: string,
    @Body() dto: AssignGuideDto,
  ): Promise<OnboardingOnboardingProgressDto> {
    if (!dto.guideId || !dto.guideName) {
      throw new BadRequestException('guideId and guideName are required');
    }

    return this.onboardingService.assignGuide(tenantId, dto.guideId, dto.guideName);
  }
}
