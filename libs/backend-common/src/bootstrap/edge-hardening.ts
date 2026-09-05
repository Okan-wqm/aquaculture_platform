/**
 * Edge hardening — what the kernel guarantees for an internet-reachable
 * service (ADR-0006, SEC-CRITICAL-056).
 *
 * # Why the factory owns this
 *
 * Production has two ingresses: `infrastructure/nginx/droplet.conf` proxies
 * the GraphQL/upload/marine surface to gateway-api, the whole `/api/`
 * catch-all to admin-api-service, device provisioning to sensor-service and
 * the Stripe webhook to billing-service. Until 2026-09-05 every edge control
 * was mounted by hand on gateway-api alone: admin-api — the most privileged
 * surface — had no access log, and with `TRUST_PROXY` unset its `req.ip` was
 * the nginx bridge address, so every per-IP rate-limit bucket was one global
 * bucket (AUTH-010). The defect class was a hand-maintained list of which
 * services are edges. This module removes the list: a service declares
 * `serviceVisibility: 'public'` and the factory applies the bundle; the
 * invariant `tests/invariants/public-service-edge-hardening.spec.ts` derives
 * the public set from nginx and fails the build when a declaration and the
 * proxy disagree.
 *
 * # The bundle
 *
 *   1. `TRUST_PROXY` is mandatory. A public service in production refuses to
 *      boot unless the variable states how many proxy hops to trust; trusting
 *      nothing behind nginx is the AUTH-010 defect written down.
 *   2. `AccessLogMiddleware` is mounted at the Express layer, ahead of every
 *      Nest middleware, so one `shared.access_logs` row exists for every
 *      request that reaches the edge — including the 401/403/CORS/throttle
 *      rejections that never reach a controller. The service must import
 *      `AccessLogModule.forRoot()`; the factory refuses to start otherwise
 *      instead of silently logging nothing.
 *
 * `StripInternalHeadersMiddleware` is deliberately NOT part of this bundle.
 * It is a mesh-wide control every service mounts in its own module chain,
 * because ordering against service-specific middleware matters (gateway-api
 * must capture `x-act-as-tenant` before the strip deletes it). The same
 * invariant enforces that mount on every bootstrapped service, with no
 * exclusion list.
 */
import type { Logger } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

import { AccessLogService } from '../audit/access-log.service';
import { AccessLogMiddleware } from '../middleware/access-log.middleware';

/**
 * Service reachability. `public` means nginx proxies internet traffic to the
 * service; `internal` means only the Docker network reaches it (gateway
 * federation, NATS, Prometheus). The invariant derives the truth from
 * `infrastructure/nginx/droplet.conf`; the declaration at the boot site must
 * match it.
 */
export type ServiceVisibility = 'public' | 'internal';

/** Express `trust proxy` setting: hop count, address list, or off. */
export type TrustProxySetting = number | string | false;

export interface TrustProxyResolutionInput {
  readonly serviceName: string;
  readonly visibility: ServiceVisibility;
  readonly isProduction: boolean;
  /** Raw `TRUST_PROXY` value, `undefined` when the variable is absent. */
  readonly rawValue: string | undefined;
}

const HOP_COUNT_PATTERN = /^\d+$/;

/**
 * Resolves `TRUST_PROXY` into the Express setting.
 *
 *   - absent, 'false', '0' → `false` (no proxy trusted)
 *   - 'true'              → `1` (the first hop)
 *   - a hop count ('2')   → that number — Express treats a numeric STRING as
 *                           an address list, so the string form is a latent
 *                           misconfiguration this function refuses to forward
 *   - anything else       → passed verbatim (`loopback`, CIDR lists)
 *
 * A public service in production must trust at least one hop: nginx fronts
 * every public service there, and a service that trusts no proxy attributes
 * every client to the reverse proxy's address.
 */
export function resolveTrustProxy(input: TrustProxyResolutionInput): TrustProxySetting {
  const { serviceName, visibility, isProduction, rawValue } = input;
  const value = rawValue?.trim();
  const mustTrustProxy = visibility === 'public' && isProduction;

  if (value === undefined || value === '') {
    if (mustTrustProxy) {
      throw new Error(
        `${serviceName} is internet-reachable (serviceVisibility 'public') and TRUST_PROXY is not set. ` +
          `Behind nginx an unset TRUST_PROXY makes req.ip the proxy address and collapses every ` +
          `per-IP rate-limit bucket into one (ADR-0006). Set TRUST_PROXY in the deploy artefact.`,
      );
    }
    return false;
  }

  if (value === 'false' || value === '0') {
    if (mustTrustProxy) {
      throw new Error(
        `${serviceName} is internet-reachable (serviceVisibility 'public') but TRUST_PROXY=${value} trusts no proxy. ` +
          `A public service in production sits behind nginx and must trust at least one hop (ADR-0006).`,
      );
    }
    return false;
  }

  if (value === 'true' || value === '1') {
    return 1;
  }

  if (HOP_COUNT_PATTERN.test(value)) {
    return Number.parseInt(value, 10);
  }

  return value;
}

/** An Express request handler the bundle installs ahead of every Nest middleware. */
export type EdgeRequestHandler = (req: Request, res: Response, next: NextFunction) => void;

/**
 * The subset of the Nest application the bundle needs. `INestApplication`
 * satisfies it structurally; the unit test drives it with a bare Express app.
 */
export interface EdgeHardeningHost {
  get(token: typeof AccessLogService, options: { strict: false }): AccessLogService;
  use(handler: EdgeRequestHandler): unknown;
}

/**
 * Mounts the edge bundle on a public service. Runs after `NestFactory.create`
 * (providers exist) and before `app.init()` (Nest middleware is not yet
 * registered), so the access log is the first handler every request meets.
 */
export function mountEdgeHardening(
  app: EdgeHardeningHost,
  serviceName: string,
  logger: Pick<Logger, 'log'>,
): void {
  let accessLogService: AccessLogService;
  try {
    accessLogService = app.get(AccessLogService, { strict: false });
  } catch (err: unknown) {
    const cause = err instanceof Error ? err.message : String(err);
    throw new Error(
      `${serviceName} is internet-reachable (serviceVisibility 'public') but its AppModule does not import ` +
        `AccessLogModule.forRoot(). Every request that reaches an edge must produce a shared.access_logs row ` +
        `(ADR-0006, AUDITTRAIL-HIGH-004). Cause: ${cause}`,
    );
  }

  const accessLog = new AccessLogMiddleware(accessLogService);
  app.use((req, res, next): void => {
    accessLog.use(req, res, next);
  });
  logger.log(`Edge hardening mounted (serviceVisibility 'public'): access log on every request`);
}
