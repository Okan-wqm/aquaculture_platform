/**
 * Request bodies for `messaging.controller.ts` (CONTRACT-CRITICAL-003).
 *
 * DTO classes live in a `*.dto.ts` file, never inside the controller: the
 * `@nestjs/swagger` plugin visits a file EITHER as a controller (typing the
 * responses) or as a model (typing the DTOs), never as both, so a DTO declared
 * beside its routes costs the whole file's response schemas.
 */
import { TenantParam, TenantIdCarrier } from '@aquaculture/backend-common/decorators';
import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsArray, IsBoolean, IsOptional, IsString, IsUUID, ValidateNested } from 'class-validator';
import { MessageAttachment } from '../../entities/support.entity';

// ============================================================================
// DTOs
// ============================================================================

/**
 * The sender is the authenticated platform admin, never a name the body
 * offers (ADMIN-CRITICAL-157).
 *
 * `CreateThreadDto` and `AddMessageDto` both accepted a `senderName`, and the
 * handlers read it as `dto.senderName || user.email` — so whatever the client
 * sent WON. The admin panel sent the string literal `'Admin'` beside a
 * `// TODO: Use actual admin name`, and every message this platform has ever
 * written to a tenant is attributed to "Admin": the tenant cannot tell which
 * person replied, and neither can the platform reading its own thread back.
 *
 * The field is gone rather than ignored. An ignored field is a contract that
 * still invites the caller to lie; a removed one makes the wrong attribution
 * unrepresentable, and `forbidNonWhitelisted` now rejects a request that tries.
 * This is the same decision the messaging subgraph already made —
 * `SupportSendMessageInput` has no `senderName` either
 * (`web/modules/tenant-admin/src/lib/api.ts:896`).
 */
export class CreateThreadDto {
  /** ADMIN-CRITICAL-009: whitelisted carrier key; the verified id arrives through @TenantParam('body'). */
  @TenantIdCarrier()
  readonly tenantId?: undefined;

  @IsString()
  subject!: string;

  @IsString()
  content!: string;
}

export class AddMessageDto {
  @IsString()
  content!: string;

  /**
   * An internal note is NOT delivered to the tenant.
   *
   * The panel had a working toggle for this and never put it on the wire, so
   * every note an admin wrote about a customer was posted into the customer's
   * own thread as a public message (ADMIN-CRITICAL-157).
   */
  @IsOptional()
  @IsBoolean()
  isInternal?: boolean;

  @IsOptional()
  @IsArray()
  attachments?: MessageAttachment[];
}

/**
 * A broadcast names its audience (ADMIN-CRITICAL-157).
 *
 * This carried an optional `tenantIds` AND an optional `targetCriteria`, and
 * the handler fell through to `BadRequestException('No target tenants
 * specified')` when a caller sent neither — which is exactly what the panel's
 * Bulk Message dialog sent, under a preview reading "This message will be sent
 * to all active tenants". Every broadcast this platform attempted answered 400,
 * and the page wrote the refusal to `console.error`.
 *
 * `targetCriteria` is now required and is the ONLY audience field:
 * `getTargetTenants` already resolves the whole space — `{}` is every active
 * tenant, `{ tenantIds }` is a chosen set, and `plans` / `regions` /
 * `excludeTenantIds` / `includeInactive` narrow it. One required field with one
 * meaning cannot be omitted, and there is no second path that can disagree
 * with it.
 */
/**
 * Who a broadcast reaches.
 *
 * A CLASS, because the audience of a message to every tenant on the platform
 * is the last thing that should reach `openapi.json` as
 * `Record<string, never>` — which is what the `AnnouncementTarget` INTERFACE
 * this replaced generated, the plugin describing classes only
 * (CONTRACT-CRITICAL-003).
 *
 * Every field here is one `MessagingService.getTargetTenants` actually
 * applies. `AnnouncementTarget` also carries `modules` and `tenantStatuses`,
 * and that method reads NEITHER — an audience filter that narrows nothing is
 * the same lie in a different place, so they are not offered on this route.
 *
 * An empty object is a meaningful audience, not a missing one: no narrowing
 * clause, plus the default `status = ACTIVE`, is every active tenant.
 */
export class BulkMessageAudienceDto {
  @ApiProperty({
    type: [String],
    required: false,
    format: 'uuid',
    description: 'Send only to these tenants. Omit for every tenant matching the other clauses.',
  })
  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  tenantIds?: string[];

  @ApiProperty({ type: [String], required: false, format: 'uuid' })
  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  excludeTenantIds?: string[];

  @ApiProperty({ type: [String], required: false, description: 'Narrow to these plan codes.' })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  plans?: string[];

  @ApiProperty({ type: [String], required: false })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  regions?: string[];

  @ApiProperty({
    required: false,
    description: 'Suspended and trial-expired tenants are excluded unless this is true.',
  })
  @IsOptional()
  @IsBoolean()
  includeInactive?: boolean;
}

export class BulkMessageDto {
  @IsString()
  subject!: string;

  @IsString()
  content!: string;

  @ApiProperty({ type: () => BulkMessageAudienceDto })
  @ValidateNested()
  @Type(() => BulkMessageAudienceDto)
  targetCriteria!: BulkMessageAudienceDto;

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
