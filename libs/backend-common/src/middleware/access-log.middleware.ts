import { Injectable, Logger, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

import { AccessLogService } from '../audit/access-log.service';
import {
  hashIpForGdpr,
  readIpHashingPolicyFromEnv,
  shouldHashIp,
} from '../audit/ip-hash.util';

/**
 * AccessLogMiddleware — emits one row per HTTP request to
 * `shared.access_logs` (AUDITTRAIL-HIGH-004).
 *
 * # Architectural shape
 *
 * This middleware sits at the request entry point and:
 *
 *   1. Captures `Date.now()` BEFORE the handler runs.
 *   2. Hooks `res.on('finish')` so the row is emitted AFTER the
 *      response is sent to the client. This means access logging
 *      adds zero blocking latency to the request path — the row
 *      INSERT happens after the response body is on the wire.
 *   3. Reads userId / tenantId / correlationId from the request
 *      (populated upstream by UserContextMiddleware /
 *      TenantContextMiddleware / CorrelationIdMiddleware).
 *   4. Routes the IP through the canonical region-gated hashing
 *      helper — same SSoT used by both audit interceptors. EU-
 *      subject access logs get hashed IPs; non-EU stay plaintext
 *      for incident-response range-containment queries.
 *
 * # Why `res.on('finish')` and not a Nest interceptor
 *
 * Nest interceptors fire at the controller boundary. They miss:
 *
 *   - 404s on unrouted paths (Nest never reaches a controller).
 *   - Filter-rejected requests (CSP, throttle, JWT guard 401s).
 *   - Static assets / health probes that bypass the Nest pipeline.
 *
 * The Express middleware layer captures every request that hits
 * the process — exactly what the auditor's invariant requires
 * ("every HTTP request emits low-level access log").
 *
 * # Why we don't await the AccessLogService.record call
 *
 * record() is fire-and-forget by design (see access-log.service.ts
 * class docstring). Awaiting here would convert observability
 * persistence failures into request-level errors — wrong posture
 * for a high-volume observability stream.
 *
 * # Why path-truncation
 *
 * Some malicious clients send pathological URLs (multi-MB query
 * strings, encoded-payload smuggling attempts). The entity
 * column is varchar(2048) so we hard-truncate at 2048 chars at
 * the middleware to avoid a 22001 (string_data_right_truncation)
 * Postgres error that would surface in the failure counter for
 * every such request. The truncation marker `…<truncated>` makes
 * the row identifiable in forensic queries.
 */
@Injectable()
export class AccessLogMiddleware implements NestMiddleware {
  private readonly logger = new Logger(AccessLogMiddleware.name);

  /**
   * Maximum path length matching the entity column size. Beyond
   * this we truncate with a clear marker. Centralized as a const
   * so the entity column resize and middleware truncation stay
   * in lockstep — change one, change the other (caught by the
   * `__tests__/access-log-shape.spec.ts` suite).
   */
  private static readonly MAX_PATH_LENGTH = 2048;
  private static readonly TRUNCATE_MARKER = '…<truncated>';

  constructor(private readonly accessLogService: AccessLogService) {}

  use(req: Request, res: Response, next: NextFunction): void {
    const start = Date.now();
    const policy = readIpHashingPolicyFromEnv();

    res.on('finish', () => {
      try {
        const durationMs = Date.now() - start;

        // ── Identity extraction ──
        // Upstream middlewares (UserContextMiddleware,
        // TenantContextMiddleware, CorrelationIdMiddleware) populate
        // these fields on the Request object. When they haven't
        // run (e.g. anonymous request paths), null is the truthful
        // value — same convention as audit_logs.
        const reqWithCtx = req as Request & {
          user?: {
            sub?: string;
            id?: string;
            tenantId?: string | null;
            region?: string | null;
          };
          tenantContext?: { tenantId?: string | null };
          correlationId?: string | null;
          /** ADR-0007: the ingress-resolved act-as target for a SUPER_ADMIN. */
          effectiveTenantId?: string;
        };
        const user = reqWithCtx.user;
        const userId = user?.sub ?? user?.id ?? null;
        // tenantId from the JWT trust anchor — same posture as
        // AUDITTRAIL-MEDIUM-003 cure on the audit interceptors.
        // The tenant the request OPERATED ON: a SUPER_ADMIN act-as target
        // outranks the (null) home tenant on the JWT.
        const tenantId =
          reqWithCtx.effectiveTenantId ??
          user?.tenantId ??
          reqWithCtx.tenantContext?.tenantId ??
          null;
        const correlationId =
          reqWithCtx.correlationId ??
          (req.headers['x-correlation-id'] as string | undefined) ??
          null;

        // ── IP region-gated hashing ──
        const rawIp = this.extractIp(req);
        const ip = shouldHashIp(user?.region ?? null, policy)
          ? hashIpForGdpr(rawIp)
          : rawIp;

        // ── Path normalization + truncation ──
        const path = this.truncatePath(req.originalUrl ?? req.url ?? '');

        this.accessLogService.record({
          method: req.method,
          path,
          status: res.statusCode,
          durationMs,
          userId,
          tenantId,
          correlationId,
          ip,
          userAgent: (req.headers['user-agent'] as string) ?? null,
        });
      } catch (err) {
        // The access-log path itself must never raise into the
        // response cycle — even though we're already past
        // `finish`, an uncaught throw inside an event listener
        // surfaces on `process` and dirties stdout. Catch here
        // and log structured.
        this.logger.error(
          `Access log emit failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    });

    next();
  }

  private extractIp(req: Request): string | null {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.length > 0) {
      return forwarded.split(',')[0]?.trim() ?? null;
    }
    return req.ip ?? null;
  }

  private truncatePath(path: string): string {
    if (path.length <= AccessLogMiddleware.MAX_PATH_LENGTH) {
      return path;
    }
    const slice = path.slice(
      0,
      AccessLogMiddleware.MAX_PATH_LENGTH -
        AccessLogMiddleware.TRUNCATE_MARKER.length,
    );
    return `${slice}${AccessLogMiddleware.TRUNCATE_MARKER}`;
  }
}
