import { RedisService } from '@aquaculture/backend-common/redis';
import { Controller, Logger, Optional } from '@nestjs/common';
import { MessagePattern, Payload, RpcException } from '@nestjs/microservices';
import {
  AUTH_CREDENTIAL_SUBJECTS,
  type VerifyPasswordQuery,
  verifyPasswordQuerySchema,
} from '@platform/event-contracts';

import { AuditLogService } from '../../../audit/audit-log.service';
import { AuditLogSeverity } from '../../../audit/audit-log.entity';
import { AuthenticationService } from '../services/authentication.service';

/** Per-user confirmation attempts allowed inside {@link VERIFY_WINDOW_SECONDS}. */
const VERIFY_MAX_ATTEMPTS = 5;
const VERIFY_WINDOW_SECONDS = 15 * 60;

/**
 * Credential-confirmation NATS responder (request.auth.verifyPassword).
 *
 * Answers exactly one question — "does this plaintext match this user's stored
 * password?" — for another service that gates an irreversible self-service
 * action on it (messaging's GDPR `anonymizeMyData`). auth-service is the
 * credential SSoT; no tenant-owned service may hold a password hash.
 *
 * Security posture (see the contract docblock for the full rationale):
 *   - Reply is a BARE BOOLEAN. Errors are surfaced as an RpcException so the
 *     caller fails CLOSED (it blocks the irreversible action), never as a
 *     `false` that a wrong password can't be told apart from a system fault.
 *   - Timing-safe + no lockout mutation (delegated to
 *     `AuthenticationService.confirmUserPassword`).
 *   - Per-user rate limit (defence-in-depth vs a compromised caller — only the
 *     messaging cert CN can reach this subject, and the legitimate mutation is
 *     already rate-limited caller-side, but a password-verify RPC without its
 *     own throttle is a guessing oracle).
 *   - AJV trust-boundary validation before any field is read.
 */
@Controller()
export class AuthCredentialNatsHandler {
  private readonly logger = new Logger(AuthCredentialNatsHandler.name);

  constructor(
    private readonly authService: AuthenticationService,
    private readonly auditLogService: AuditLogService,
    // Optional so local/test wiring without Redis still boots; production
    // always has the global RedisModule, so the throttle is always active there.
    @Optional() private readonly redis?: RedisService,
  ) {}

  @MessagePattern(AUTH_CREDENTIAL_SUBJECTS.VERIFY_PASSWORD)
  async verifyPassword(@Payload() payload: VerifyPasswordQuery): Promise<boolean> {
    if (!verifyPasswordQuerySchema(payload)) {
      // Malformed payload from a (possibly compromised) peer — fail closed.
      throw new RpcException('verifyPassword: invalid request payload');
    }

    await this.enforceRateLimit(payload.userId);

    try {
      const matched = await this.authService.confirmUserPassword(
        payload.userId,
        payload.password,
      );
      // SECURITY AUDIT: record the confirmation attempt (userId only, no PII).
      // A burst of failures here is a credential-probing signal.
      await this.audit(
        matched ? 'PASSWORD_CONFIRMATION_SUCCESS' : 'PASSWORD_CONFIRMATION_FAILED',
        payload.userId,
        matched,
        matched ? AuditLogSeverity.INFO : AuditLogSeverity.WARNING,
      );
      return matched;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`verifyPassword failed for userId=${payload.userId}: ${message}`);
      // Fail closed — surface as an RPC error so the caller blocks the
      // irreversible action rather than mistaking a fault for a valid password.
      throw new RpcException('verifyPassword: internal error');
    }
  }

  /**
   * Atomic per-user fixed-window throttle backed by the shared Redis. `incr`
   * is atomic; `expire` on the first hit bounds the window. Degrades to
   * no-throttle only when Redis is absent (local/test), where the caller-side
   * rate limit remains the control.
   */
  private async enforceRateLimit(userId: string): Promise<void> {
    if (!this.redis) return;
    const key = `auth:verify-password:${userId}`;
    const count = await this.redis.incr(key);
    if (count === 1) {
      await this.redis.expire(key, VERIFY_WINDOW_SECONDS);
    }
    if (count > VERIFY_MAX_ATTEMPTS) {
      await this.audit(
        'PASSWORD_CONFIRMATION_RATE_LIMITED',
        userId,
        false,
        AuditLogSeverity.WARNING,
      );
      throw new RpcException('verifyPassword: rate limit exceeded');
    }
  }

  private async audit(
    action: string,
    userId: string,
    success: boolean,
    severity: AuditLogSeverity,
  ): Promise<void> {
    try {
      await this.auditLogService.log({
        performedBy: userId,
        action,
        entityType: 'User',
        entityId: userId,
        details: { success, timestamp: new Date().toISOString() },
        severity,
      });
    } catch (err) {
      // Audit is best-effort here; never let it fail the confirmation path.
      this.logger.error(
        `Failed to log security event ${action}: ${(err as Error).message}`,
      );
    }
  }
}
