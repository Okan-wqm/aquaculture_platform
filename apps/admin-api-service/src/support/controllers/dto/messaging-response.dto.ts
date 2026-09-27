/**
 * The wire shapes of the admin↔tenant messaging reads (CONTRACT-CRITICAL-003,
 * ADMIN-CRITICAL-157).
 *
 * Every one of these routes was typed by inference, and the `@nestjs/swagger`
 * plugin describes CLASSES only, so `openapi.json` said `{"type":"object"}` for
 * all of them. The panel answered by hand-writing the shapes, and the
 * hand-written ones disagreed with the server on the three things that decide
 * what an operator sees:
 *
 *  - **`senderType`.** The panel's union was
 *    `'super_admin' | 'tenant_admin' | 'system'`. This service has never sent
 *    `'super_admin'` — `addMessage` writes `'admin'`, and the column's own
 *    union is `'admin' | 'tenant_admin' | 'system'`. So the page's
 *    `senderType === 'super_admin'` test was false for every message ever
 *    written: the platform's own replies rendered as inbound tenant messages,
 *    and the read receipt keyed on the same test never rendered at all.
 *  - **`status`.** The panel's union omitted `'failed'`, so a message that
 *    failed to send was drawn as one that had been sent and not yet read.
 *  - **`attachments`.** The server sends `fileName` / `fileSize` /
 *    `uploadedAt`; the panel declared `filename` / `size`. Every attachment
 *    rendered as a nameless link reading "NaN MB".
 *
 * ## Why the message list is a page
 *
 * `getMessages` took `page` and `limit`, defaulted `limit` to 50, and returned
 * a BARE ARRAY — the total stayed on the server. A thread with more than 50
 * messages handed the panel its first 50 with nothing to say so, while the
 * thread header printed `messageCount` from a different query. The operator
 * read "128 messages" above a pane holding 50 and had no way to reach the rest.
 * A page carries its own total, so the truncation is visible and answerable.
 *
 * ## Why the average is nullable
 *
 * `calculateAvgResponseTime` returned `Math.round(avg || 0)`, and the pair
 * query returns SQL NULL when no admin has ever answered a tenant. Zero is a
 * measurement: an "Avg Response 0m" card reads as an instant reply from a
 * platform that has never replied once.
 */
import { ApiProperty } from '@nestjs/swagger';
import type { PaginationResultV1 } from '@platform/pagination-contracts';

export class MessageAttachmentResponseDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  fileName!: string;

  @ApiProperty({ description: 'Size in bytes.' })
  fileSize!: number;

  @ApiProperty()
  mimeType!: string;

  @ApiProperty()
  url!: string;

  @ApiProperty()
  uploadedAt!: string;
}

/**
 * One `admin.messages` row.
 *
 * The `thread` relation is deliberately absent: `getMessages` loads no
 * relations, so it is never on the wire.
 */
export class SupportMessageResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  threadId!: string;

  @ApiProperty({ format: 'uuid' })
  senderId!: string;

  @ApiProperty({
    enum: ['admin', 'tenant_admin', 'system'],
    description:
      "The platform side is 'admin'. There is no 'super_admin' — the panel's union invented it, and every test against it was false.",
  })
  senderType!: 'admin' | 'tenant_admin' | 'system';

  @ApiProperty({
    required: false,
    description:
      'Display name captured when the message was written, derived from the authenticated sender. ABSENT when unknown — the column is nullable and `JSON.stringify` omits undefined.',
  })
  senderName?: string;

  @ApiProperty()
  content!: string;

  @ApiProperty({
    enum: ['sent', 'delivered', 'read', 'failed'],
    description:
      "'failed' is a real state; a client that omits it draws a failure as an unread send.",
  })
  status!: 'sent' | 'delivered' | 'read' | 'failed';

  @ApiProperty({ description: 'Internal notes are not shown to the tenant.' })
  isInternal!: boolean;

  @ApiProperty({
    type: () => [MessageAttachmentResponseDto],
    required: false,
    description: 'Absent when the message carries no attachments.',
  })
  attachments?: MessageAttachmentResponseDto[];

  @ApiProperty({ description: 'Whether the message was emailed to the tenant.' })
  emailSent!: boolean;

  @ApiProperty({
    type: String,
    format: 'date-time',
    required: false,
    description: 'When the counterparty read it. Absent while unread.',
  })
  readAt?: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: Date;
}

/**
 * One page of a thread's messages (ADMIN-HIGH-004 pattern).
 *
 * `@platform/pagination-contracts` owns the shape; this class only restates
 * the field set, because the plugin can generate nothing from a generic alias
 * in a library. `implements` is the compile-time binding.
 */
export class SupportMessagePageDto implements PaginationResultV1<SupportMessageResponseDto> {
  @ApiProperty({ type: () => [SupportMessageResponseDto] })
  readonly items!: readonly SupportMessageResponseDto[];
  readonly total!: number;
  readonly page!: number;
  readonly limit!: number;
  readonly totalPages!: number;
  readonly hasNextPage!: boolean;
  readonly hasPreviousPage!: boolean;
}

export class MessagingStatsResponseDto {
  @ApiProperty({ description: 'Threads that are not archived.' })
  totalThreads!: number;

  @ApiProperty()
  activeThreads!: number;

  @ApiProperty()
  closedThreads!: number;

  @ApiProperty({ description: 'Every message row, archived threads included.' })
  totalMessages!: number;

  @ApiProperty({ description: 'Messages awaiting an admin, summed over unarchived threads.' })
  unreadMessages!: number;

  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'Mean minutes between a tenant message and the admin reply that followed it, over the pairs that EXIST. null when no admin has ever answered — not 0, which reads as an instant reply.',
  })
  avgResponseTimeMinutes!: number | null;
}

/**
 * What a broadcast actually did (ADMIN-CRITICAL-157).
 *
 * `sendBulkMessage` opens one thread per tenant in a loop and counts the ones
 * that threw. The panel declared the reply `void` and discarded it, so a
 * broadcast that reached 3 of 400 tenants closed its dialog exactly like one
 * that reached all 400.
 */
export class BulkMessageResultDto {
  @ApiProperty({ description: 'Tenants whose thread was created.' })
  sent!: number;

  @ApiProperty({ description: 'Tenants whose thread FAILED. A non-zero value is a partial send.' })
  failed!: number;

  @ApiProperty({ type: [String], description: 'The threads that were created.' })
  threadIds!: string[];
}

export class UnreadCountResponseDto {
  @ApiProperty()
  unreadCount!: number;
}

/**
 * The thread row `POST /support/messages/threads` replies with.
 *
 * Declared rather than inferred because the inferred shape was the ENTITY, and
 * the entity carries `messages: Message[]` — a relation `createThread` does not
 * load, because it saves the row and returns it. `GET
 * /support/messages/threads/:id` DOES load it, so the relation is not hidden
 * from the contract; it is simply not part of THIS route's reply, and a client
 * typed from the artifact had to fabricate the field to compile
 * (ADMIN-CRITICAL-157, the ADMIN-MEDIUM-114 pattern).
 */
export class CreatedMessageThreadDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  tenantId!: string;

  @ApiProperty()
  subject!: string;

  @ApiProperty({ required: false, format: 'uuid' })
  lastMessageId?: string;

  @ApiProperty()
  messageCount!: number;

  @ApiProperty()
  unreadAdminCount!: number;

  @ApiProperty()
  unreadTenantCount!: number;

  @ApiProperty()
  isArchived!: boolean;

  @ApiProperty()
  isClosed!: boolean;

  @ApiProperty({ type: String, format: 'date-time', required: false })
  lastMessageAt?: Date;

  @ApiProperty({ type: Object, required: false })
  metadata?: Record<string, unknown>;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt!: Date;
}
