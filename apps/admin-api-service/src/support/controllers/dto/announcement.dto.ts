/**
 * Request bodies for `announcement.controller.ts` (CONTRACT-CRITICAL-003).
 *
 * DTO classes live in a `*.dto.ts` file, never inside the controller: the
 * `@nestjs/swagger` plugin visits a file EITHER as a controller (typing the
 * responses) or as a model (typing the DTOs), never as both, so a DTO declared
 * beside its routes costs the whole file's response schemas.
 */
import { TenantParam, TenantIdCarrier } from '@aquaculture/backend-common/decorators';
import { IsString, IsOptional, IsBoolean, IsObject } from 'class-validator';
import { AnnouncementType, AnnouncementTarget } from '../../entities/support.entity';

// ============================================================================
// DTOs
// ============================================================================

export class CreateAnnouncementDto {
  @IsString()
  title!: string;

  @IsString()
  content!: string;

  @IsString()
  type!: AnnouncementType;

  @IsBoolean()
  isGlobal!: boolean;

  @IsOptional()
  @IsObject()
  targetCriteria?: AnnouncementTarget;

  @IsOptional()
  @IsString()
  publishAt?: string;

  @IsOptional()
  @IsString()
  expiresAt?: string;

  @IsOptional()
  @IsBoolean()
  requiresAcknowledgment?: boolean;
}

export class UpdateAnnouncementDto {
  @IsOptional()
  @IsString()
  title?: string;

  @IsOptional()
  @IsString()
  content?: string;

  @IsOptional()
  @IsString()
  type?: AnnouncementType;

  @IsOptional()
  @IsBoolean()
  isGlobal?: boolean;

  @IsOptional()
  @IsObject()
  targetCriteria?: AnnouncementTarget;

  @IsOptional()
  @IsString()
  publishAt?: string;

  @IsOptional()
  @IsString()
  expiresAt?: string;

  @IsOptional()
  @IsBoolean()
  requiresAcknowledgment?: boolean;
}

export class AcknowledgeDto {
  /** ADMIN-CRITICAL-009: whitelisted carrier key; the verified id arrives through @TenantParam('body'). */
  @TenantIdCarrier()
  readonly tenantId?: undefined;

  @IsString()
  userId!: string;

  @IsString()
  userName!: string;
}
