/**
 * Request bodies for `ticket.controller.ts` (CONTRACT-CRITICAL-003).
 *
 * DTO classes live in a `*.dto.ts` file, never inside the controller: the
 * `@nestjs/swagger` plugin visits a file EITHER as a controller (typing the
 * responses) or as a model (typing the DTOs), never as both, so a DTO declared
 * beside its routes costs the whole file's response schemas.
 */
import { TenantParam, TenantIdCarrier } from '@aquaculture/backend-common/decorators';
import { IsString, IsOptional, IsArray, IsBoolean, IsNumber } from 'class-validator';
import {
  TicketPriority,
  TicketStatus,
  TicketCategory,
  TicketAttachment,
} from '../../entities/support.entity';

// ============================================================================
// DTOs
// ============================================================================

export class CreateTicketDto {
  /** ADMIN-CRITICAL-009: whitelisted carrier key; the verified id arrives through @TenantParam('body'). */
  @TenantIdCarrier()
  readonly tenantId?: undefined;

  @IsOptional()
  @IsString()
  tenantName?: string;

  @IsString()
  subject!: string;

  @IsString()
  description!: string;

  @IsOptional()
  @IsString()
  category?: TicketCategory;

  @IsOptional()
  @IsString()
  priority?: TicketPriority;

  @IsOptional()
  @IsArray()
  tags?: string[];
}

export class UpdateTicketDto {
  @IsOptional()
  @IsString()
  subject?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  category?: TicketCategory;

  @IsOptional()
  @IsString()
  priority?: TicketPriority;

  @IsOptional()
  @IsString()
  status?: TicketStatus;

  @IsOptional()
  @IsArray()
  tags?: string[];

  @IsOptional()
  @IsString()
  dueAt?: string;
}

export class AssignTicketDto {
  @IsString()
  assignedTo!: string;

  @IsString()
  assignedToName!: string;
}

export class AddCommentDto {
  @IsString()
  content!: string;

  @IsOptional()
  @IsString()
  authorName?: string;

  @IsOptional()
  @IsBoolean()
  isInternal?: boolean;

  @IsOptional()
  @IsArray()
  attachments?: TicketAttachment[];
}

export class ChangeStatusDto {
  @IsString()
  status!: TicketStatus;
}

export class ChangePriorityDto {
  @IsString()
  priority!: TicketPriority;
}

export class SatisfactionRatingDto {
  @IsNumber()
  rating!: number;

  @IsOptional()
  @IsString()
  feedback?: string;
}
