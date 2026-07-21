import { IsString, IsUUID, MinLength, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';
import { LEGAL_HOLD_MIN_RELEASE_REASON_CHARS } from '@platform/event-contracts';

/**
 * Body for `POST /messaging/compliance/legal-holds/:id/release`.
 *
 * Enforces the LEGAL-MEDIUM-002 dual-approver release contract at the REST
 * trust boundary. Being a class (not a TS interface), the global ValidationPipe
 * (`whitelist` + `forbidNonWhitelisted` + `transform`) actually engages: a
 * missing/short `releaseReason` or a non-UUID `approverId` is rejected with a
 * non-retried **400** carrying the real message — instead of the pre-fix path
 * where the fields were dropped entirely and the request only failed at the
 * deep messaging-service command handler, surfacing as a retried **502**
 * (APA-163). The forwarded NATS payload is typed against the shared
 * `MessagingAdminRpcRequest` contract, so it cannot drift from this DTO.
 */
export class ReleaseLegalHoldDto {
  /** Tenant that owns the hold; scopes the release so a hold cannot be lifted cross-tenant. */
  @IsUUID('4')
  tenantId!: string;

  /**
   * The SECOND, distinct SUPER_ADMIN countersigning the release. The command
   * handler and the DB CHECK constraint `chk_legal_hold_no_self_approval`
   * reject `approverId === releaser`.
   */
  @IsUUID('4')
  approverId!: string;

  /**
   * Free-text justification recorded on the hold row. Trimmed before validation
   * so a whitespace-only reason is rejected here exactly as the service layer
   * (which checks `releaseReason.trim().length`) would reject it.
   */
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(LEGAL_HOLD_MIN_RELEASE_REASON_CHARS)
  @MaxLength(1000)
  releaseReason!: string;
}
