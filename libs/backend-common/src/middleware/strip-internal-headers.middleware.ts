/**
 * Strip Internal Headers Middleware — canonical, cross-service.
 *
 * # Why this middleware exists
 *
 * Internal services trust four request headers to carry user/tenant
 * context across hops:
 *
 *   - x-user-payload  (full decoded JWT payload, JSON-stringified)
 *   - x-user-id
 *   - x-user-roles
 *   - x-tenant-id
 *
 * If any of these arrives on an EXTERNAL request (one not signed by a
 * trusted internal service), it is a forgery attempt — an attacker who
 * controls a Docker-network host could otherwise craft
 * `x-user-payload: {"role":"SUPER_ADMIN","tenantId":null}` against any
 * `@Public()` endpoint and gain SUPER_ADMIN context. SEC-CRITICAL-002 +
 * SECREV-CRITICAL-002 captured the exact gap on auth-service +
 * billing-service AppModules — neither registered the middleware, so
 * forged headers passed through untouched to UserContextMiddleware which
 * trusted them.
 *
 * # What it does
 *
 *   1. Reads x-service-identity + x-service-signature.
 *   2. Verifies the signature is `HMAC-SHA256(identity, INTERNAL_SERVICE_SECRET)`.
 *   3. If signature is valid → request is from a trusted internal source,
 *      headers are forwarded as-is.
 *   4. If signature is missing OR invalid → strips the four spoofable
 *      headers from `req.headers` so downstream middleware/guards see
 *      no forged context.
 *
 * # Why this middleware lives in backend-common
 *
 * Pre-fix the implementation lived in apps/gateway-api/. The audit
 * captured 14+ other services that needed identical protection but
 * could not reuse the gateway-local class without a `apps/`-cross-import
 * (forbidden by Nx project boundaries). Promoting it to backend-common
 * lets every service mount it via the bootstrap helper or its own
 * MiddlewareConsumer registration.
 *
 * # MUST run BEFORE auth middleware
 *
 * Order matters: a forged x-user-payload header would be picked up by
 * UserContextMiddleware / JwtMiddleware before this middleware fires
 * if registered later. Each service's AppModule MUST mount this
 * middleware as the FIRST `apply()` call against its global routes.
 *
 * Closes: docs/reviews/auth-security-expert/2026-04-28-core-platform-review.md#SEC-CRITICAL-002
 * Closes: docs/reviews/security-reviewer/2026-04-28-core-platform-review.md#SECREV-CRITICAL-002
 */

import { Injectable, NestMiddleware, Logger, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response, NextFunction } from 'express';
import { createHmac, timingSafeEqual } from 'crypto';

/**
 * The four request headers we treat as INTERNAL trust anchors. Any of
 * these on an external (un-signed) request is a forgery attempt and is
 * stripped. Update this list ONLY in concert with the matching guard /
 * middleware that reads each header.
 */
const INTERNAL_HEADERS_TO_STRIP = [
  'x-user-payload',
  'x-user-id',
  'x-user-roles',
  'x-tenant-id',
] as const;

@Injectable()
export class StripInternalHeadersMiddleware implements NestMiddleware {
  private readonly logger = new Logger(StripInternalHeadersMiddleware.name);
  private readonly serviceSecret: string | undefined;

  constructor(
    @Inject(ConfigService) private readonly configService: ConfigService,
  ) {
    this.serviceSecret = this.configService.get<string>('INTERNAL_SERVICE_SECRET');
  }

  use(req: Request, _res: Response, next: NextFunction): void {
    if (!this.isValidInternalRequest(req)) {
      for (const header of INTERNAL_HEADERS_TO_STRIP) {
        if (req.headers[header]) {
          this.logger.warn(
            `Stripped spoofed internal header "${header}" from external request ` +
              `(ip=${req.ip ?? 'unknown'}, path=${req.path})`,
          );
          delete req.headers[header];
        }
      }
    }
    next();
  }

  /**
   * Validate that the request is from a trusted internal service.
   *
   * # Contract
   *
   * Requires both `x-service-identity` and `x-service-signature` headers.
   * The signature MUST be `HMAC-SHA256(identity, INTERNAL_SERVICE_SECRET)`.
   *
   * # Why this is a NARROWER check than the W0.A v2 service-identity
   *
   * The full v2 signature contract (libs/.../service-identity.util.ts)
   * binds method + path + body + tenantId. THIS middleware uses a
   * lighter `HMAC(identity)` because it runs on EVERY request — the
   * additional verification cost would dominate hot-path latency. Its
   * job is the strip-or-trust decision, not full request authentication.
   * The full v2 verification still fires AFTER this middleware in the
   * `ServiceIdentityGuard` (or each service's equivalent) before any
   * privileged action is taken.
   */
  private isValidInternalRequest(req: Request): boolean {
    if (!this.serviceSecret) return false;

    const identity = req.headers['x-service-identity'];
    const signature = req.headers['x-service-signature'];
    if (typeof identity !== 'string' || typeof signature !== 'string') return false;

    try {
      const expected = createHmac('sha256', this.serviceSecret).update(identity).digest('hex');
      if (expected.length !== signature.length) return false;
      return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
    } catch {
      return false;
    }
  }
}
