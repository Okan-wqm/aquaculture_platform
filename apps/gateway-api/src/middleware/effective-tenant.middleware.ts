/**
 * Effective-tenant resolution — the gateway is the SINGLE tenant-resolution
 * authority (tenant-context SSoT).
 *
 * WHY this exists
 * ----------------
 * A SUPER_ADMIN has `tenantId = null` in their JWT (platform account). To view a
 * tenant's data they "act as" that tenant. The browser sends the selected tenant
 * in `x-tenant-id`/`x-act-as-tenant`, but StripInternalHeadersMiddleware deletes
 * those spoofable headers, and `/graphql` skips tenant resolution — so the act-as
 * never reached the subgraphs. The gateway signed `effectiveTenantId = user.tenantId`
 * (null), so every tenant-scoped read landed on the wrong/empty schema
 * non-deterministically ("data sometimes loads, sometimes not").
 *
 * The fix (Option A — validated header capture):
 *   1. {@link CaptureRequestedTenantMiddleware} captures the requested act-as
 *      BEFORE the strip middleware deletes it (it is UNTRUSTED intent at this point).
 *   2. {@link EffectiveTenantMiddleware} (after JWT auth) resolves the ONE
 *      `req.effectiveTenantId` with full authority validation.
 *   3. AuthenticatedDataSource signs `effectiveTenantId` into the HMAC user-
 *      assertion, so it cannot be spoofed downstream and survives header-stripping.
 *   4. Every subgraph reads the signed `effectiveTenantId` (via
 *      VerifiedUserAssertionMiddleware -> req.tenantId) as the SSoT for the RLS
 *      GUC, search_path routing and TenantGuard.
 */
import {
  Injectable,
  NestMiddleware,
  ForbiddenException,
  Logger,
  Optional,
  Inject,
} from '@nestjs/common';
import { isLoginAllowed, TenantStatus } from '@platform/event-contracts';
import type { Request, Response, NextFunction } from 'express';

import { JwtPayload } from '../guards/auth.guard';
import { TenantLookupService } from '../services/tenant-lookup.service';

/**
 * Minimal port the middleware depends on (abstraction, not the concrete service)
 * so the active-tenant check is trivially mockable. The concrete
 * TenantLookupService is structurally assignable and injected by token below.
 */
export interface TenantActiveCheck {
  lookupTenant(tenantId: string): Promise<{ status: TenantStatus } | null>;
}

const TENANT_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Browser-supplied act-as intent, in precedence order. Both are stripped by
// StripInternalHeadersMiddleware — captured here only as an INTENT to validate.
const ACT_AS_HEADERS = ['x-act-as-tenant', 'x-tenant-id'] as const;

/** Express request augmented with the resolved tenant-context SSoT fields. */
export interface RequestWithEffectiveTenant extends Request {
  user?: JwtPayload & { mfaVerified?: boolean };
  /** Untrusted browser act-as intent, captured pre-strip. */
  requestedActAsTenant?: string;
  /** The single resolved, authority-validated effective tenant (the SSoT). */
  effectiveTenantId?: string;
}

function isSuperAdmin(user: RequestWithEffectiveTenant['user']): boolean {
  return user?.roles?.includes('SUPER_ADMIN') ?? false;
}

/**
 * Capture the requested act-as tenant BEFORE StripInternalHeadersMiddleware runs.
 * MUST be mounted before the strip middleware. The captured value is untrusted.
 */
@Injectable()
export class CaptureRequestedTenantMiddleware implements NestMiddleware {
  use(req: Request, _res: Response, next: NextFunction): void {
    const r = req as RequestWithEffectiveTenant;
    for (const header of ACT_AS_HEADERS) {
      const value = req.headers[header];
      if (typeof value === 'string' && value.trim()) {
        r.requestedActAsTenant = value.trim();
        break;
      }
    }
    next();
  }
}

/**
 * Resolve the single effective tenant the gateway will sign. MUST be mounted
 * AFTER JwtMiddleware/UserContextMiddleware so `req.user` is populated.
 *
 * Precedence + authority:
 *  - Unauthenticated (login/public): no effective tenant.
 *  - Regular user: effectiveTenantId = JWT tenantId. A divergent act-as is a
 *    cross-tenant attempt → 403 (defense-in-depth; the header is also stripped).
 *  - SUPER_ADMIN: the act-as tenant, only after UUID + tenant-ACTIVE (fail-closed
 *    in production) + MFA-step-up (when MFA_REQUIRED_FOR_CROSS_TENANT) checks.
 *    No act-as → system scope (tenant-scoped ops then fail closed downstream).
 */
@Injectable()
export class EffectiveTenantMiddleware implements NestMiddleware {
  private readonly logger = new Logger(EffectiveTenantMiddleware.name);
  private readonly isProduction = process.env['NODE_ENV'] === 'production';

  constructor(
    @Optional()
    @Inject(TenantLookupService)
    private readonly tenantLookup?: TenantActiveCheck,
  ) {}

  async use(req: Request, _res: Response, next: NextFunction): Promise<void> {
    const r = req as RequestWithEffectiveTenant;
    const user = r.user;
    const requested = r.requestedActAsTenant;

    // Unauthenticated requests (login, health, pre-auth) carry no tenant scope.
    if (!user) {
      return next();
    }

    if (!isSuperAdmin(user)) {
      // Regular users: the tenant comes EXCLUSIVELY from the verified JWT claim.
      // A request that tries to act as a DIFFERENT tenant is a cross-tenant
      // escalation attempt — reject it (the header was already stripped; this is
      // belt-and-suspenders).
      if (requested && user.tenantId && requested !== user.tenantId) {
        this.logger.warn(
          `Rejected cross-tenant act-as by non-SUPER_ADMIN user=${user.sub} (requested=${requested})`,
        );
        throw new ForbiddenException('Cross-tenant access is not permitted for this account');
      }
      r.effectiveTenantId = user.tenantId ?? undefined;
      return next();
    }

    // ---- SUPER_ADMIN acting-as a tenant ----
    if (!requested) {
      // Platform/system scope — no tenant selected. Tenant-scoped ops fail closed
      // downstream (RLS denies, TenantGuard/resolvers reject) rather than silently
      // returning another tenant's or empty data.
      r.effectiveTenantId = user.tenantId ?? undefined;
      return next();
    }

    if (!TENANT_UUID_RE.test(requested)) {
      throw new ForbiddenException('Act-as tenant must be a valid UUID');
    }

    // Validate the target tenant exists and is ACTIVE. Fail CLOSED in production:
    // a missing lookup service must not let an unvalidated act-as through.
    if (this.tenantLookup) {
      const tenant = await this.tenantLookup.lookupTenant(requested);
      if (!tenant || !isLoginAllowed(tenant.status)) {
        throw new ForbiddenException('Act-as target tenant is not active');
      }
    } else if (this.isProduction) {
      throw new Error(
        'CRITICAL: TenantLookupService not registered — cannot validate SUPER_ADMIN act-as in production.',
      );
    }

    // MFA step-up for cross-tenant access (mirrors TenantGuard policy).
    const sourceTenant = user.tenantId ?? null;
    const isCrossTenant = requested !== sourceTenant;
    if (
      isCrossTenant &&
      process.env['MFA_REQUIRED_FOR_CROSS_TENANT'] === 'true' &&
      !user.mfaVerified
    ) {
      throw new ForbiddenException('MFA step-up is required for cross-tenant access');
    }

    r.effectiveTenantId = requested;
    if (isCrossTenant) {
      // Cross-tenant access is a security-relevant event — surface it. (The
      // signed assertion carries effectiveTenantId; downstream services audit
      // per-operation.)
      this.logger.log(
        `SUPER_ADMIN cross-tenant access: user=${user.sub} acting as tenant=${requested}`,
      );
    }
    next();
  }
}
