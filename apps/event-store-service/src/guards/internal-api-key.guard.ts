import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'crypto';
import { Request } from 'express';

/**
 * Maximum allowed clock skew for service identity timestamps (5 minutes).
 * Requests older than this are rejected to prevent replay attacks.
 */
const SERVICE_IDENTITY_MAX_AGE_MS = 5 * 60 * 1000;

/**
 * Guard that verifies inter-service authentication for event-store-service.
 *
 * Supports two authentication methods (checked in order):
 * 1. HMAC-signed service identity (preferred): X-Service-Identity + X-Service-Timestamp + X-Service-Signature
 * 2. Legacy API key: X-Internal-Api-Key (deprecated, for backward compatibility)
 *
 * SECURITY: Also logs the X-Tenant-Id header value with the calling service identity
 * for audit trail purposes — the event-store accepts tenant context from headers
 * and the audit log is the primary detection mechanism for misuse.
 *
 * Health check endpoints are excluded from authentication.
 */
@Injectable()
export class InternalApiKeyGuard implements CanActivate {
  private readonly logger = new Logger(InternalApiKeyGuard.name);
  private warnedNoSecret = false;

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();

    // Allow health check endpoints without authentication
    if (request.path.includes('/health')) {
      return true;
    }

    const secret = process.env['INTERNAL_SERVICE_SECRET'] || process.env['INTERNAL_API_KEY'];

    // In development without a configured key, warn but allow
    if (!secret) {
      if (process.env['NODE_ENV'] === 'production') {
        this.logger.error(
          'Neither INTERNAL_SERVICE_SECRET nor INTERNAL_API_KEY is configured in production — rejecting request',
        );
        throw new UnauthorizedException('Service authentication required');
      }
      if (!this.warnedNoSecret) {
        this.warnedNoSecret = true;
        this.logger.warn(
          'No service authentication configured — all requests allowed in development mode',
        );
      }
      return true;
    }

    // ── Method 1: HMAC service identity (preferred) ──
    const serviceName = request.headers['x-service-identity'] as string | undefined;
    const timestamp = request.headers['x-service-timestamp'] as string | undefined;
    const signature = request.headers['x-service-signature'] as string | undefined;

    if (serviceName && timestamp && signature) {
      // SECURITY (HIGH-003): bind X-Tenant-ID into HMAC verification. A
      // compromised caller cannot forward a valid signature with a spoofed
      // tenant header because the signature was computed over the original
      // tenantId. Absent header verifies with empty string (non-tenant path).
      const tenantHeader = (request.headers['x-tenant-id'] as string | undefined) ?? '';
      const valid = this.verifyServiceIdentity(serviceName, timestamp, signature, secret, tenantHeader);
      if (!valid) {
        this.logger.warn(
          `Rejected request: invalid service identity signature from "${serviceName}"` +
            (tenantHeader ? ` (tenant=${tenantHeader})` : ''),
        );
        throw new UnauthorizedException(
          'Invalid service identity signature. Request may be forged, expired, or the tenant header was tampered with.',
        );
      }

      // SECURITY: Audit log for tenant access via service identity
      if (tenantHeader) {
        this.logger.log(
          `Service "${serviceName}" accessing tenant "${tenantHeader}" via ${request.method} ${request.path}`,
        );
      }

      return true;
    }

    // ── Method 2: Legacy API key (backward compatible) ──
    const requestKey = request.headers['x-internal-api-key'] as string | undefined;

    if (!requestKey) {
      throw new UnauthorizedException('Missing service authentication headers');
    }

    const isValid =
      requestKey.length === secret.length &&
      timingSafeEqual(Buffer.from(requestKey), Buffer.from(secret));

    if (!isValid) {
      throw new UnauthorizedException('Invalid internal API key');
    }

    // SECURITY: Audit log for tenant access via legacy API key
    const tenantId = request.headers['x-tenant-id'] as string | undefined;
    if (tenantId) {
      this.logger.warn(
        `Legacy API key access to tenant "${tenantId}" via ${request.method} ${request.path} — migrate to service identity headers`,
      );
    }

    return true;
  }

  /**
   * Verify HMAC-signed service identity.
   * Signature = HMAC-SHA256(timestamp:serviceName:tenantId, secret)
   *
   * SECURITY (HIGH-003): tenantId is bound into the signature so a
   * compromised caller cannot forward a valid signature with a spoofed
   * X-Tenant-ID header. tenantId is '' when no tenant context applies.
   */
  private verifyServiceIdentity(
    serviceName: string,
    timestamp: string,
    signature: string,
    secret: string,
    tenantId: string,
  ): boolean {
    const ts = parseInt(timestamp, 10);
    if (isNaN(ts)) {
      return false;
    }
    const age = Math.abs(Date.now() - ts);
    if (age > SERVICE_IDENTITY_MAX_AGE_MS) {
      return false;
    }

    const expected = createHmac('sha256', secret)
      .update(`${timestamp}:${serviceName}:${tenantId}`)
      .digest('hex');

    if (expected.length !== signature.length) {
      return false;
    }

    return timingSafeEqual(
      Buffer.from(expected, 'utf8'),
      Buffer.from(signature, 'utf8'),
    );
  }
}
