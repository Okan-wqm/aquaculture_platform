/**
 * The wire shapes of the three announcement reads the admin panel renders
 * (CONTRACT-CRITICAL-003, ADMIN-HIGH-145).
 *
 * `GET /support/announcements`, `GET /support/announcements/stats` and
 * `GET /support/announcements/:id/acknowledgments` each returned an anonymous
 * inline object type, and the `@nestjs/swagger` plugin describes CLASSES only
 * — so all three carried NO response schema at all in `openapi.json`. Every
 * page reads on this screen were therefore hand-typed on the client, and both
 * hand-typed shapes were wrong:
 *
 *   - the create payload was derived as `Omit<Announcement, … |
 *     'acknowledgedCount' | …>` — a key the read shape does not have (it is
 *     `acknowledgmentCount`), so the subtraction dropped nothing there and the
 *     "create" type went on demanding `status`, `acknowledgmentCount` and a
 *     full `acknowledgments` roster that `CreateAnnouncementDto` rejects. The
 *     page compiled only because it cast the form's output;
 *   - the list filter declared `isPublished`, a query parameter this
 *     controller does not have, and omitted `status`, the one the page
 *     actually sends. A query key the server does not know is not an error —
 *     it is ignored (the ADMIN-HIGH-123 class).
 *
 * These classes state the JSON so the artifact describes it and the client can
 * derive its types from the contract instead of restating them beside it.
 */
import { ApiProperty } from '@nestjs/swagger';
import type { PaginationResultV1 } from '@platform/pagination-contracts';

import { Announcement, AnnouncementAcknowledgment } from '../../entities/support.entity';

export class AnnouncementStatsByTypeDto {
  @ApiProperty({ description: 'Announcements of type `info`, in any status.' })
  info!: number;

  @ApiProperty({ description: 'Announcements of type `warning`, in any status.' })
  warning!: number;

  @ApiProperty({ description: 'Announcements of type `critical`, in any status.' })
  critical!: number;

  @ApiProperty({ description: 'Announcements of type `maintenance`, in any status.' })
  maintenance!: number;
}

export class AnnouncementStatsResponseDto {
  @ApiProperty({
    description:
      'Every announcement row, in any status. Counted over the whole table — ' +
      'not over the page the list endpoint returned, which is capped.',
  })
  total!: number;

  @ApiProperty({ description: 'Announcements currently published.' })
  published!: number;

  @ApiProperty({ description: 'Announcements with a future publish time.' })
  scheduled!: number;

  @ApiProperty({ description: 'Announcements never published.' })
  draft!: number;

  @ApiProperty({ description: 'Announcements past their expiry.' })
  expired!: number;

  @ApiProperty({ description: 'Sum of `viewCount` over every announcement.' })
  totalViews!: number;

  @ApiProperty({ description: 'Sum of `acknowledgmentCount` over every announcement.' })
  totalAcknowledgments!: number;

  @ApiProperty({
    type: AnnouncementStatsByTypeDto,
    description: 'One count per announcement type. The four keys are always present.',
  })
  byType!: AnnouncementStatsByTypeDto;
}

export class AnnouncementAcknowledgmentStatusDto {
  @ApiProperty({ description: "The announcement's own view counter." })
  totalViews!: number;

  @ApiProperty({ description: "The announcement's own acknowledgment counter." })
  totalAcknowledgments!: number;

  @ApiProperty({
    type: () => [AnnouncementAcknowledgment],
    description:
      'Every view or acknowledgment recorded against this announcement, newest ' +
      'first. An empty array means nobody has seen it — which is why a failed ' +
      'read must never be rendered as one.',
  })
  acknowledgments!: AnnouncementAcknowledgment[];
}

/**
 * The page contract as the swagger plugin can see it (ADMIN-HIGH-004).
 *
 * `@platform/pagination-contracts` owns the shape and is the only place that
 * CONSTRUCTS one — this class never assembles a page, it only restates the
 * field set, because the plugin can generate nothing from
 * `PaginationResultV1<T>`, a generic alias in a library. `implements` is the
 * compile-time binding: a field added to the authority is an error here, not a
 * silent omission on the wire.
 */
export class AnnouncementPageDto implements PaginationResultV1<Announcement> {
  // The plugin infers a property's schema from its declared type and cannot
  // read `readonly T[]`: an explicit lazy resolver is the documented way out,
  // and it keeps the `readonly` the authority's type requires.
  @ApiProperty({ type: () => [Announcement] })
  readonly items!: readonly Announcement[];
  readonly total!: number;
  readonly page!: number;
  readonly limit!: number;
  readonly totalPages!: number;
  readonly hasNextPage!: boolean;
  readonly hasPreviousPage!: boolean;
}
