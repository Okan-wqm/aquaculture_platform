import { IsInt, IsOptional, IsUUID, Min } from 'class-validator';

/**
 * Body for `PUT /messaging/retention/policies/:id`.
 *
 * A class (not a TS interface) so the global ValidationPipe engages and a
 * malformed `retentionDays` (the pre-fix `parseInt` NaN path, APA-179) is
 * rejected with a 400 at the edge. `-1` is the sentinel for indefinite
 * retention; messaging-service's `set-retention-policy.handler` enforces the
 * exact business allowlist downstream. The tenant scope comes from the `:id`
 * path param and the acting user from the JWT — neither is a body field.
 */
export class UpdateRetentionPolicyDto {
  /** Channel-scoped override; `null`/omitted means the tenant-wide policy. */
  @IsOptional()
  @IsUUID('4')
  channelId?: string | null;

  @IsInt()
  @Min(-1)
  retentionDays!: number;
}
