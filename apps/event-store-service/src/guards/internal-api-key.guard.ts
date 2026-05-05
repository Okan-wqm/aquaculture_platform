import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';
import { timingSafeEqual } from 'crypto';
import { Request } from 'express';
import { verifyServiceIdentityRequest } from '@aquaculture/backend-common/utils';

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

    // ── Method 1: v2 HMAC service identity (preferred) ──
    //
    // Closes: SEC-CRITICAL-001 — verifyServiceIdentityRequest binds method,
    // path, and body into the canonical input via the shared library, which
    // also rejects v1 traffic once the W0.A-finalize commit lands. The
    // hand-rolled HMAC implementation that lived in this guard was a
    // duplicate of the v1 logic in libs/backend-common — collapsing into
    // the single canonical verifier removes the drift risk.
    const serviceIdentity = request.headers['x-service-identity'] as string | undefined;
    const serviceTimestamp = request.headers['x-service-timestamp'] as string | undefined;
    const serviceSignature = request.headers['x-service-signature'] as string | undefined;

    if (serviceIdentity && serviceTimestamp && serviceSignature) {
      const tenantHeader = (request.headers['x-tenant-id'] as string | undefined) ?? '';
      const observedBody = this.serializeBodyForHash((request as Request & { body?: unknown }).body);
      const observedPath = (() => {
        const raw = request.originalUrl ?? request.url ?? request.path ?? '/';
        const qIdx = raw.indexOf('?');
        return qIdx === -1 ? raw : raw.slice(0, qIdx);
      })();

      const outcome = verifyServiceIdentityRequest({
        headers: request.headers as Record<string, string | string[] | undefined>,
        observedMethod: request.method ?? 'POST',
        observedPath,
        observedBody,
        secret,
        expectedTenantId: tenantHeader,
      });

      if (!outcome.valid) {
        this.logger.warn(
          `Rejected request: ${outcome.reason} from "${serviceIdentity}"` +
            (tenantHeader ? ` (tenant=${tenantHeader})` : ''),
        );
        throw new UnauthorizedException(
          outcome.reason === 'missing-headers'
            ? 'Missing service identity headers'
            : 'Invalid service identity signature. Request may be forged, expired, or fields tampered with.',
        );
      }

      // Audit log for tenant access via service identity (v1 + v2 alike).
      if (tenantHeader) {
        this.logger.log(
          `Service "${serviceIdentity}" accessing tenant "${tenantHeader}" via ${request.method} ${request.path} (sig=${outcome.version})`,
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
   * Coerce the parsed body back into a byte-stable representation for sha256.
   *
   * WHY: Express + body-parser already JSON.parse'd the body for us; we
   * re-serialize so the hash matches what the SENDER computed before
   * stringifying. Buffer/string passthrough is byte-exact.
   */
  private serializeBodyForHash(body: unknown): string | Buffer {
    if (body === undefined || body === null) return '';
    if (typeof body === 'string') return body;
    if (Buffer.isBuffer(body)) return body;
    return JSON.stringify(body);
  }
}
