import { decodeGatewayVerifiedUserAssertionHeaderV1 } from '@aquaculture/shared-contracts';
import { BadRequestException, Injectable, Logger, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

import type { TenantRequest, VerifiedUserAssertion } from '../types/tenant-request.interface';

const ASSERTION_HEADER = 'x-verified-user-assertion';
const LEGACY_IDENTITY_HEADERS = [
  'x-user-payload',
  'x-user-id',
  'x-user-roles',
  'x-act-as-tenant',
] as const;

/**
 * Parses the gateway-minted farm identity assertion after service HMAC
 * verification and quarantines legacy raw identity headers.
 */
@Injectable()
export class VerifiedUserAssertionMiddleware implements NestMiddleware {
  private readonly logger = new Logger(VerifiedUserAssertionMiddleware.name);

  use(req: TenantRequest, _res: Response, next: NextFunction): void {
    try {
      const assertionHeader = this.getHeader(req, ASSERTION_HEADER);

      if (!req.verifiedIdentity && this.requiresServiceIdentity(req)) {
        throw new BadRequestException('Subgraph request requires service identity');
      }

      if (!assertionHeader && this.requiresGatewayAssertion(req)) {
        throw new BadRequestException(
          'Verified user assertion is required for gateway subgraph requests',
        );
      }

      if (assertionHeader) {
        if (!req.verifiedIdentity) {
          throw new BadRequestException('Verified user assertion requires service identity');
        }
        if (req.verifiedIdentity.serviceName !== 'gateway-api') {
          throw new BadRequestException(
            'Verified user assertion issuer must match gateway service identity',
          );
        }

        const assertion = this.parseAssertion(assertionHeader);
        if (!assertion.subject) {
          throw new BadRequestException('Verified user assertion is missing subject');
        }
        if (
          req.verifiedIdentity.tenantId &&
          assertion.effectiveTenantId !== req.verifiedIdentity.tenantId
        ) {
          throw new BadRequestException(
            'Verified user assertion tenant does not match signed service tenant',
          );
        }

        req.verifiedUserAssertion = assertion;
        req.tenantId = assertion.effectiveTenantId ?? assertion.tenantId ?? undefined;
        req.user = {
          sub: assertion.subject,
          tenantId: req.tenantId,
          roles: [...assertion.roles],
          email: assertion.email ?? undefined,
          mfaVerified: assertion.mfaVerified,
          // SEC-HIGH-051 / SEC-HIGH-052: expose the object-level authorization
          // claims on the PRODUCTION gateway path (where req.user is rebuilt
          // from the assertion, NOT the raw JWT). Without this the claims would
          // be undefined at every prod resolver and all non-managers would
          // fail-closed — a functional outage.
          ...(assertion.assignedSiteIds !== undefined
            ? { assignedSiteIds: [...assertion.assignedSiteIds] }
            : {}),
          ...(assertion.mobileFeatures !== undefined
            ? { mobileFeatures: [...assertion.mobileFeatures] }
            : {}),
          // SSOT-C-13: expose the plan tier ordinal so resource-create handlers
          // can enforce per-plan quotas on the production gateway path.
          ...(assertion.planLevel !== undefined ? { planLevel: assertion.planLevel } : {}),
          // MT-HIGH-054: expose the tenant-RBAC capabilities so subgraph
          // @RequireTenantPermission / hasResourcePermission work on the prod
          // gateway path. Without this every non-admin fails closed on any
          // capability-gated route (a functional outage — same class as the
          // sites/mobileFeatures fix above).
          ...(assertion.resourcePermissions !== undefined
            ? { resourcePermissions: [...assertion.resourcePermissions] }
            : {}),
        };

        // Once the gateway assertion is the authoritative identity, drop the
        // legacy identity headers so UserContextMiddleware cannot re-derive a
        // different (or forged) user from them. Strip ONLY when an assertion is
        // present: in dev/E2E (no assertion) the legacy x-user-payload path is
        // the test harness's identity source, and a no-assertion PRODUCTION
        // gateway request is already rejected above (requiresGatewayAssertion),
        // while StripInternalHeadersMiddleware removes spoofable headers from
        // non-signed production requests. Stripping unconditionally here broke
        // every subgraph E2E that authenticates via x-user-payload.
        for (const header of LEGACY_IDENTITY_HEADERS) {
          if (req.headers[header]) {
            Reflect.deleteProperty(req.headers, header);
          }
        }
      }

      next();
    } catch (error) {
      const path = this.requestPath(req);
      const reason = error instanceof Error ? error.message : 'ASSERTION_INVALID';
      this.logger.warn(
        `Rejected verified user assertion on ${req.method} ${path}: ${reason}`,
      );
      next(error);
    }
  }

  private parseAssertion(value: string): VerifiedUserAssertion {
    try {
      return decodeGatewayVerifiedUserAssertionHeaderV1(value);
    } catch (error) {
      const code = error instanceof Error ? error.message : 'ASSERTION_INVALID';
      if (code === 'ASSERTION_EXPIRED_OR_NOT_YET_VALID') {
        throw new BadRequestException('Verified user assertion is expired or not yet valid');
      }
      throw new BadRequestException(`Verified user assertion is invalid (${code})`);
    }
  }

  private requiresGatewayAssertion(req: TenantRequest): boolean {
    return (
      this.requiresServiceIdentity(req) &&
      req.verifiedIdentity?.serviceName === 'gateway-api' &&
      this.hasAuthorizationHeader(req)
    );
  }

  /**
   * Public login/refresh GraphQL operations are still transported by the
   * certificate-authenticated gateway but have no authenticated user to bind
   * into an assertion. Once a bearer credential is present, the matching
   * gateway assertion is mandatory and fail-closed.
   */
  private hasAuthorizationHeader(req: TenantRequest): boolean {
    const authorization = this.getHeader(req, 'authorization');
    return typeof authorization === 'string' && authorization.trim().length > 0;
  }

  private requiresServiceIdentity(req: TenantRequest): boolean {
    return process.env['NODE_ENV'] === 'production' && !this.isProbePath(req);
  }

  private isProbePath(req: Request): boolean {
    const path = this.requestPath(req);
    return (
      path === '/metrics' ||
      path === '/health' ||
      path.startsWith('/health/') ||
      path === '/api/metrics' ||
      path === '/api/health' ||
      path.startsWith('/api/health/')
    );
  }

  private requestPath(req: Request): string {
    const rawPath = req.originalUrl ?? req.url ?? req.path ?? '/';
    return rawPath.split('?')[0] || '/';
  }

  private getHeader(req: Request, name: string): string | undefined {
    const value = req.headers[name.toLowerCase()] ?? req.headers[name];
    return Array.isArray(value) ? value[0] : value;
  }
}
