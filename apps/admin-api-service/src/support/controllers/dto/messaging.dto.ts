/**
 * Request bodies for `messaging.controller.ts` (CONTRACT-CRITICAL-003).
 *
 * DTO classes live in a `*.dto.ts` file, never inside the controller: the
 * `@nestjs/swagger` plugin visits a file EITHER as a controller (typing the
 * responses) or as a model (typing the DTOs), never as both, so a DTO declared
 * beside its routes costs the whole file's response schemas.
 */
import { TenantParam, TenantIdCarrier } from '@aquaculture/backend-common/decorators';
import { IsString, IsOptional, IsBoolean, IsArray, IsObject } from 'class-validator';
import { MessageAttachment, AnnouncementTarget } from '../../entities/support.entity';

// ============================================================================
// DTOs
// ============================================================================

export class CreateThreadDto {
  /** ADMIN-CRITICAL-009: whitelisted carrier key; the verified id arrives through @TenantParam('body'). */
  @TenantIdCarrier()
  readonly tenantId?: undefined;

  @IsString()
  subject!: string;

  @IsString()
  content!: string;

  @IsOptional()
  @IsString()
  senderName?: string;
}

export class AddMessageDto {
  @IsString()
  content!: string;

  @IsOptional()
  @IsString()
  senderName?: string;

  @IsOptional()
  @IsBoolean()
  isInternal?: boolean;

  @IsOptional()
  @IsArray()
  attachments?: MessageAttachment[];
}

export class BulkMessageDto {
  @IsString()
  subject!: string;

  @IsString()
  content!: string;

  @IsOptional()
  @IsObject()
  targetCriteria?: AnnouncementTarget;

  @IsOptional()
  @IsArray()
  tenantIds?: string[];

  @IsOptional()
  @IsBoolean()
  sendEmail?: boolean;
}
