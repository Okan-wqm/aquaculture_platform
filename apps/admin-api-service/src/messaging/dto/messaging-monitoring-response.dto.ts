/**
 * The wire shapes of the two cross-tenant messaging aggregates
 * (CONTRACT-CRITICAL-003, ADMIN-MEDIUM-152).
 *
 * `GET /messaging/monitoring/stats` and `GET /messaging/tenants` were typed by
 * INTERFACES declared inside the controller, and the `@nestjs/swagger` plugin
 * describes classes only — so both carried `"schema": {"type": "object"}` in
 * `openapi.json`. The admin panel answered by hand-writing the same five
 * shapes in `services/types/messaging.ts`.
 *
 * Unusually, those hand-written copies are CORRECT: ADMIN-HIGH-009 wrote both
 * sides together and they still agree field for field. That is exactly why
 * this is worth closing now rather than after it breaks — the drift this
 * prevents has not happened yet, and every other page in this audit that
 * hand-wrote a response type had already drifted from it (ADMIN-HIGH-110,
 * ADMIN-MEDIUM-111, ADMIN-CRITICAL-150, ADMIN-CRITICAL-151).
 *
 * DTO classes live in a `*.dto.ts` file, never inside the controller: the
 * plugin visits a file EITHER as a controller (typing the responses) or as a
 * model (typing the DTOs), never as both.
 */
import { ApiProperty } from '@nestjs/swagger';

export class TenantMessagingOverviewRowDto {
  @ApiProperty({ format: 'uuid' })
  tenantId!: string;

  @ApiProperty({ description: 'Messages created in the last 24 hours.' })
  messageCount24h!: number;

  @ApiProperty({ description: 'Messages created in the last 7 days.' })
  messageCount7d!: number;

  @ApiProperty({ description: 'Messages of any age.' })
  totalMessages!: number;

  @ApiProperty({ description: 'Channels that are not archived.' })
  activeChannels!: number;
}

export class MessagingOutboxHealthDto {
  @ApiProperty({ description: 'Events enqueued but not yet published, and not dead-lettered.' })
  pendingCount!: number;

  @ApiProperty({
    description:
      'Dead-lettered events that exhausted their retries. These are NOT retried automatically.',
  })
  failedCount!: number;

  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'Age in seconds of the oldest pending event; null when nothing is pending. Null is not zero — a dashboard must not render it as an age.',
  })
  oldestPendingAgeSeconds!: number | null;
}

export class MessagingMonitoringTotalsDto {
  @ApiProperty({ description: 'Messages of any age, across every tenant.' })
  totalMessages!: number;

  @ApiProperty()
  messages24h!: number;

  @ApiProperty()
  messages7d!: number;

  @ApiProperty({ description: 'Non-archived channels across every tenant.' })
  activeChannels!: number;

  @ApiProperty({ description: 'Tenants with messages or active channels.' })
  tenantCount!: number;
}

export class MessagingMonitoringStatsDto {
  @ApiProperty({ type: MessagingMonitoringTotalsDto })
  totals!: MessagingMonitoringTotalsDto;

  @ApiProperty({
    type: () => [TenantMessagingOverviewRowDto],
    description: 'Per-tenant breakdown, sorted by 24h message volume descending.',
  })
  perTenant!: TenantMessagingOverviewRowDto[];

  @ApiProperty({ type: MessagingOutboxHealthDto })
  outbox!: MessagingOutboxHealthDto;

  @ApiProperty({
    description:
      'When messaging-service computed the aggregate. It caches for 60 seconds, so this is the age of the numbers, not of the request.',
  })
  generatedAt!: string;
}

export class MessagingTenantsOverviewDto {
  @ApiProperty({
    type: () => [TenantMessagingOverviewRowDto],
    description: 'Per-tenant rows, sorted by 24h message volume descending.',
  })
  tenants!: TenantMessagingOverviewRowDto[];

  @ApiProperty({ description: 'When messaging-service computed the aggregate.' })
  generatedAt!: string;
}

/**
 * What `POST /messaging/tenants/:id/export` returns (ADMIN-HIGH-153).
 *
 * The controller declared `{ exportId: string; status: string }`. The reply has
 * neither `exportId` — the field is `jobId` — nor five of its other fields,
 * and the one it omitted hardest is **`data`**: the export payload itself,
 * already serialised to JSON or CSV by
 * `DataExportService.exportTenant`. admin-api forwarded it, the admin panel's
 * hand-written type did not mention it, and the page threw it away — so a GDPR
 * Art 20 export ran, crossed the wire in full, and left the operator with a
 * record count and no file.
 *
 * `status` is the literal `'completed'`: the service exports synchronously, in
 * the request. The route answered `202 Accepted` for work that was already
 * done, which is why the page's own copy said the job "runs asynchronously".
 */
export class TenantDataExportResultDto {
  @ApiProperty({ format: 'uuid', description: 'Identifies this export in the audit log.' })
  jobId!: string;

  @ApiProperty({
    description: "Always 'completed': the export is performed synchronously, inside the request.",
  })
  status!: string;

  @ApiProperty({ enum: ['csv', 'json'] })
  format!: string;

  @ApiProperty({ description: 'Rows in the export.' })
  recordCount!: number;

  @ApiProperty({
    description:
      'The export itself, serialised as JSON or CSV. This is the file — there is no second endpoint to fetch it from, and nothing stores it server-side.',
  })
  data!: string;

  @ApiProperty({
    description:
      'Whether the tenant is under an effective legal hold. The export still runs; the flag records that the data is preserved for a matter.',
  })
  isUnderLegalHold!: boolean;

  @ApiProperty()
  exportedAt!: string;
}
