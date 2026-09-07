/**
 * Request bodies for `onboarding.controller.ts` (CONTRACT-CRITICAL-003).
 *
 * DTO classes live in a `*.dto.ts` file, never inside the controller: the
 * `@nestjs/swagger` plugin visits a file EITHER as a controller (typing the
 * responses) or as a model (typing the DTOs), never as both, so a DTO declared
 * beside its routes costs the whole file's response schemas.
 */
import { TenantParam, TenantIdCarrier } from '@aquaculture/backend-common/decorators';
import { IsString, IsOptional, IsNumber, IsIn } from 'class-validator';

// ============================================================================
// DTOs
// ============================================================================

export class InitializeOnboardingDto {
  /** ADMIN-CRITICAL-009: whitelisted carrier key; the verified id arrives through @TenantParam('body'). */
  @TenantIdCarrier()
  readonly tenantId?: undefined;

  @IsString()
  tenantName!: string;
}

export class SendWelcomeEmailDto {
  @IsString()
  recipientEmail!: string;

  @IsString()
  recipientName!: string;
}

export class ScheduleTrainingDto {
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

export class UpdateTrainingDto {
  @IsIn(['completed', 'cancelled'])
  status!: 'completed' | 'cancelled';

  @IsOptional()
  @IsString()
  notes?: string;
}

export class AssignGuideDto {
  @IsString()
  guideId!: string;

  @IsString()
  guideName!: string;
}
