/**
 * The wire shapes of the two ticket reads the admin panel renders
 * (CONTRACT-CRITICAL-003, ADMIN-CRITICAL-156, ADMIN-MEDIUM-114).
 *
 * Both were typed by inference, and the `@nestjs/swagger` plugin describes
 * classes only, so the artifact said nothing about either. The panel answered
 * by hand-writing both — and got both wrong in ways that were invisible:
 *
 *  - `GET /support/tickets/stats` sends ten required numbers. The panel's
 *    `TicketStats` declared TWENTY fields, half of them optional aliases the
 *    server has never sent (`avgResponseTime`, `avgResolutionTime`,
 *    `satisfactionScore`, `byCategory`, `byPriority`), and marked the four
 *    real ones optional. That is where the page's `a || b || 0` chains and its
 *    `slaBreachCount ? … : 100` came from: the type said the truth might be
 *    missing, so the page invented a value for when it was.
 *  - `GET /support/tickets/:id/comments` returns a PAGINATED result. The panel
 *    declared a flat array, so `(data || []).map(...)` ran `.map` on the page
 *    OBJECT, threw a TypeError, and the page's `catch` wrote it to
 *    `console.error` — every ticket's comment thread rendered empty, silently
 *    (ADMIN-MEDIUM-114 tracked the missing DTO; this is what it cost).
 *
 * ## Why three averages are nullable
 *
 * `getTicketStats` computed `0` when there was nothing to average — no first
 * responses yet, nothing resolved yet, nobody has rated. Zero is a
 * measurement: "0m average response" reads as instant, and a 0-star
 * satisfaction card reads as universal dissatisfaction. `null` says there is
 * no observation, and the panel renders an em dash for it.
 */
import { ApiProperty } from '@nestjs/swagger';
import type { PaginationResultV1 } from '@platform/pagination-contracts';

import type { TicketAttachment } from '../../entities/support.entity';

export class TicketStatsResponseDto {
  @ApiProperty({ description: 'Every ticket row, in any status.' })
  total!: number;

  @ApiProperty()
  open!: number;

  @ApiProperty()
  inProgress!: number;

  @ApiProperty()
  waitingCustomer!: number;

  @ApiProperty()
  resolved!: number;

  @ApiProperty()
  closed!: number;

  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'Mean minutes to first response, over tickets that HAVE one. null when no ticket has been responded to — not 0, which reads as instant.',
  })
  avgFirstResponseMinutes!: number | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'Mean minutes to resolution, over RESOLVED tickets. null when nothing has been resolved.',
  })
  avgResolutionMinutes!: number | null;

  @ApiProperty({ description: 'Tickets whose SLA is marked breached.' })
  slaBreachCount!: number;

  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'Mean satisfaction rating over tickets that were RATED. null when none were — not 0, which reads as universal dissatisfaction.',
  })
  avgSatisfactionRating!: number | null;
}

export class TicketAttachmentResponseDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  fileName!: string;

  @ApiProperty()
  fileSize!: number;

  @ApiProperty()
  mimeType!: string;

  @ApiProperty()
  url!: string;

  @ApiProperty()
  uploadedAt!: string;
}

/**
 * One `admin.ticket_comments` row.
 *
 * The `ticket` relation is deliberately absent: `getComments` loads no
 * relations, so it is never on the wire. Inferring the response from the
 * ENTITY is what made the contract's `TicketComment` require a whole
 * `SupportTicket` inside every comment — the reason
 * `services/types/support.ts` could not alias it and hand-wrote the shape
 * instead (ADMIN-MEDIUM-114).
 */
export class TicketCommentResponseDto {
  @ApiProperty()
  id!: string;

  @ApiProperty({ format: 'uuid' })
  ticketId!: string;

  @ApiProperty({ format: 'uuid' })
  authorId!: string;

  @ApiProperty({ enum: ['admin', 'tenant_user', 'system'] })
  authorType!: 'admin' | 'tenant_user' | 'system';

  @ApiProperty({
    required: false,
    description:
      'Display name captured when the comment was written. ABSENT from the payload when unknown — the column is nullable and `JSON.stringify` omits undefined, so a client must treat the key as optional rather than expecting null.',
  })
  authorName?: string;

  @ApiProperty()
  content!: string;

  @ApiProperty({ description: 'Internal notes are not shown to the tenant.' })
  isInternal!: boolean;

  @ApiProperty({
    type: () => [TicketAttachmentResponseDto],
    required: false,
    description: 'Absent when the comment carries no attachments.',
  })
  attachments?: TicketAttachment[];

  @ApiProperty({ description: 'Whether the comment was emailed to the tenant.' })
  emailSent!: boolean;

  // A `Date` on the server, an ISO string on the wire. The declared metadata
  // is what a client reads, so it says date-time.
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: Date;
}

/**
 * One page of a ticket's comments (ADMIN-HIGH-004 pattern).
 *
 * `@platform/pagination-contracts` owns the shape; this class only restates
 * the field set, because the plugin can generate nothing from a generic alias
 * in a library. `implements` is the compile-time binding.
 */
export class TicketCommentPageDto implements PaginationResultV1<TicketCommentResponseDto> {
  @ApiProperty({ type: () => [TicketCommentResponseDto] })
  readonly items!: readonly TicketCommentResponseDto[];
  readonly total!: number;
  readonly page!: number;
  readonly limit!: number;
  readonly totalPages!: number;
  readonly hasNextPage!: boolean;
  readonly hasPreviousPage!: boolean;
}
