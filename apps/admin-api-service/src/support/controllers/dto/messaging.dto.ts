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

/**
 * One row of `GET /support/messages/threads`.
 *
 * A response shape, not a request body, and a CLASS rather than the interface
 * it replaced. The `@nestjs/swagger` plugin only emits schemas for classes, so
 * as an interface this projection was invisible to `openapi.json` — the admin
 * panel had nothing authoritative to source it from and hand-declared it
 * against the GraphQL thread instead, reading `unreadCountAdmin` and `status`
 * off a payload that carries `unreadCount` and `isClosed` (ADMIN-HIGH-110).
 *
 * `MessagingService.getAllThreads` builds this: `unreadCount` is the thread's
 * `unreadAdminCount`, `tenantName` comes out of the thread metadata, and
 * `lastMessage` is the newest message's first 100 characters.
 */
export class ThreadSummaryDto {
  id!: string;
  tenantId!: string;
  tenantName!: string;
  subject!: string;
  lastMessage!: string;
  lastMessageAt!: Date;
  unreadCount!: number;
  messageCount!: number;
  isClosed!: boolean;
}
