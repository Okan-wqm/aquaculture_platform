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
import { verifyServiceIdentityRequest } from '../utils/service-identity.util';
import { hashVerifiedUserAssertionHeaders } from '../http/gateway-verified-user-assertion';

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
    this.serviceSecret =
      this.configService.get<string>('INTERNAL_SERVICE_SECRET');
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
   * v2 requests use the canonical service-identity verifier; legacy
   * requests use `HMAC-SHA256(identity, INTERNAL_SERVICE_SECRET)`.
   *
   * # Why this accepts both v2 and the legacy narrow proof
   *
   * Current callers should send the full v2 service-identity signature
   * (method + path + body + tenant binding). The legacy HMAC(identity)
   * proof remains accepted for the rolling window because this middleware's
   * job is the strip-or-trust decision; full request authentication still
   * fires afterward in ServiceIdentityGuard.
   */
  private isValidInternalRequest(req: Request): boolean {
    if (!this.serviceSecret) return false;

    const identity = req.headers['x-service-identity'];
    const signature = req.headers['x-service-signature'];
    if (typeof identity !== 'string' || typeof signature !== 'string') return false;

    if (req.headers['x-service-sig-version'] === 'v2') {
      const tenantHeader =
        (req.headers['x-tenant-id'] as string | undefined) ?? '';
      const outcome = verifyServiceIdentityRequest({
        headers: req.headers as Record<string, string | string[] | undefined>,
        observedMethod: req.method ?? 'GET',
        observedPath: this.canonicalisePath(req),
        observedBody: this.serializeBodyForHash(req.body),
        observedAssertionHash: hashVerifiedUserAssertionHeaders(
          req.headers as Record<string, string | string[] | undefined>,
        ),
        secret: this.serviceSecret,
        expectedTenantId: tenantHeader,
      });
      return outcome.valid;
    }

    try {
      const expected = createHmac('sha256', this.serviceSecret)
        .update(identity)
        .digest('hex');
      if (expected.length !== signature.length) return false;
      return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
    } catch {
      return false;
    }
  }

  private serializeBodyForHash(body: unknown): string | Buffer {
    if (body === undefined || body === null) return '';
    if (typeof body === 'string') return body;
    if (Buffer.isBuffer(body)) return body;
    return JSON.stringify(body);
  }

  private canonicalisePath(req: {
    path?: string;
    originalUrl?: string;
    url?: string;
  }): string {
    // Use the full wire path when Express has mounted a route and `path`
    // becomes mount-relative. This must match ServiceIdentityGuard.
    const raw = req.originalUrl ?? req.url ?? req.path ?? '/';
    const qIdx = raw.indexOf('?');
    return qIdx === -1 ? raw : raw.slice(0, qIdx);
  }
}
