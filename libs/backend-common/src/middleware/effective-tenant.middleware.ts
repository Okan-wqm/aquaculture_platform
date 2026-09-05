/**
 * Act-as authority — the kernel's SINGLE cross-tenant access control
 * (ADR-0007, SEC-CRITICAL-057; tenant-context SSoT).
 *
 * # Why this exists
 *
 * A SUPER_ADMIN has `tenantId = null` in their JWT (platform account). To view
 * a tenant's data they "act as" that tenant. The browser sends the selected
 * tenant in `x-act-as-tenant` / `x-tenant-id`, but StripInternalHeadersMiddleware
 * deletes those spoofable headers, so the intent must be captured BEFORE the
 * strip and validated AFTER authentication:
 *
 *   1. {@link CaptureRequestedTenantMiddleware} captures the requested act-as
 *      tenant, reason and ticket (UNTRUSTED intent) before the strip runs.
 *   2. {@link EffectiveTenantMiddleware} (after JWT auth) resolves the ONE
 *      `req.effectiveTenantId` with full authority validation — UUID, tenant
 *      ACTIVE (fail-closed in production), MFA step-up, and for a cross-tenant
 *      act-as a REQUIRED reason plus optional ticket — and records the
 *      resulting {@link ActAsContext} on the request.
 *   3. The ingress signs `effectiveTenantId` and the act-as claims into the
 *      HMAC user-assertion, so downstream services cannot be handed a spoofed
 *      tenant and every audit row they write carries `actorHomeTenantId`,
 *      `actedOnTenantId`, `mfaVerified` and the reason/ticket.
 *
 * # Why the kernel owns it
 *
 * Until 2026-09-05 this lived in gateway-api while admin-api-service carried
 * an "impersonation" module whose token nothing consumed and whose sessions
 * table refused every lifecycle write. Two authorities, one of them decorative.
 * ADR-0007 deletes the module and makes this middleware the only cross-tenant
 * authority; `tests/invariants/cross-tenant-authority-ssot.spec.ts` asserts no
 * second implementation exists and that every browser-authenticating ingress
 * mounts this one in the right order.
 */
import {
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NestMiddleware,
  Optional,
} from '@nestjs/common';
import { isLoginAllowed, TenantStatus } from '@platform/event-contracts';
import type { NextFunction, Request, Response } from 'express';

import { getRequestContext } from '../logging/request-context';
import type { ActAsContext } from '../types/tenant-request.interface';

/**
 * Minimal port the middleware depends on (abstraction, not a concrete service)
 * so the active-tenant check is trivially mockable. An ingress binds it with
 * `{ provide: TENANT_ACTIVE_CHECK, useExisting: <its lookup service> }`.
 */
export interface TenantActiveCheck {
  lookupTenant(tenantId: string): Promise<{ status: TenantStatus } | null>;
}

/** DI token for the {@link TenantActiveCheck} port. */
export const TENANT_ACTIVE_CHECK = Symbol.for('aquaculture.tenant-active-check');

/** The identity fields the act-as decision reads; every JWT payload on the platform satisfies it. */
export interface ActAsPrincipal {
  sub: string;
  tenantId?: string | null;
  roles?: readonly string[];
  mfaVerified?: boolean;
}

/** Browser-supplied act-as headers. All are untrusted intent until validated here. */
export const ACT_AS_TENANT_HEADER = 'x-act-as-tenant';
export const ACT_AS_REASON_HEADER = 'x-act-as-reason';
export const ACT_AS_TICKET_HEADER = 'x-act-as-ticket';

/** Bounds on the free-text reason and the ticket reference persisted to audit rows. */
export const ACT_AS_REASON_MAX_LENGTH = 512;
export const ACT_AS_TICKET_MAX_LENGTH = 128;
const ACT_AS_TICKET_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._\-/#]*$/;

const TENANT_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Browser-supplied act-as intent, in precedence order. Both are stripped by
// StripInternalHeadersMiddleware — captured here only as an INTENT to validate.
const ACT_AS_TENANT_HEADERS = [ACT_AS_TENANT_HEADER, 'x-tenant-id'] as const;

/** Express request augmented with the resolved tenant-context SSoT fields. */
export interface RequestWithEffectiveTenant extends Request {
  user?: ActAsPrincipal;
  /** Untrusted browser act-as intent, captured pre-strip. */
  requestedActAsTenant?: string;
  /** Untrusted operator-supplied justification, captured pre-strip. */
  requestedActAsReason?: string;
  /** Untrusted ticket reference, captured pre-strip. */
  requestedActAsTicket?: string;
  /** The single resolved, authority-validated effective tenant (the SSoT). */
  effectiveTenantId?: string;
  /** Present only for a validated SUPER_ADMIN cross-tenant act-as. */
  actAs?: ActAsContext;
}

function isSuperAdmin(user: ActAsPrincipal | undefined): boolean {
  return user?.roles?.includes('SUPER_ADMIN') ?? false;
}

function headerValue(req: Request, name: string): string | undefined {
  const value = req.headers[name];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Capture the requested act-as tenant, reason and ticket BEFORE
 * StripInternalHeadersMiddleware runs. MUST be mounted before the strip
 * middleware. Everything captured here is untrusted.
 */
@Injectable()
export class CaptureRequestedTenantMiddleware implements NestMiddleware {
  use(req: Request, _res: Response, next: NextFunction): void {
    const r = req as RequestWithEffectiveTenant;
    for (const header of ACT_AS_TENANT_HEADERS) {
      const value = headerValue(req, header);
      if (value) {
        r.requestedActAsTenant = value;
        break;
      }
    }
    r.requestedActAsReason = headerValue(req, ACT_AS_REASON_HEADER);
    r.requestedActAsTicket = headerValue(req, ACT_AS_TICKET_HEADER);
    next();
  }
}

/**
 * Resolve the single effective tenant the ingress will sign. MUST be mounted
 * AFTER the JWT middleware so `req.user` is populated.
 *
 * Precedence + authority:
 *  - Unauthenticated (login/public): no effective tenant.
 *  - Regular user: effectiveTenantId = JWT tenantId. A divergent act-as is a
 *    cross-tenant attempt → 403 (defense-in-depth; the header is also stripped).
 *  - SUPER_ADMIN: the act-as tenant, only after UUID + tenant-ACTIVE (fail-closed
 *    in production) + MFA-step-up (when MFA_REQUIRED_FOR_CROSS_TENANT) checks,
 *    and — when the target is not the actor's home tenant — a non-empty
 *    X-Act-As-Reason (X-Act-As-Ticket optional). No act-as → system scope
 *    (tenant-scoped ops then fail closed downstream).
 */
@Injectable()
export class EffectiveTenantMiddleware implements NestMiddleware {
  private readonly logger = new Logger(EffectiveTenantMiddleware.name);
  private readonly isProduction = process.env['NODE_ENV'] === 'production';

  constructor(
    @Optional()
    @Inject(TENANT_ACTIVE_CHECK)
    private readonly tenantLookup?: TenantActiveCheck,
  ) {}

  /**
   * Set the request's effective tenant AND enrich the AsyncLocalStorage
   * logging frame so every subsequent log line carries the EFFECTIVE tenant.
   * RequestContextMiddleware established the frame earlier from the JWT tenant
   * only; for a SUPER_ADMIN acting-as a tenant the effective tenant differs,
   * and StructuredLoggerService reads ctx.tenantId live at log time. No-op
   * (and safe) when no ALS frame is active.
   */
  private setEffectiveTenant(r: RequestWithEffectiveTenant, tenantId: string | undefined): void {
    r.effectiveTenantId = tenantId;
    if (tenantId) {
      getRequestContext().tenantId = tenantId;
    }
  }

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
        this.logger.warn(JSON.stringify({ event: 'non_super_admin_cross_tenant_act_as_rejected' }));
        throw new ForbiddenException('Cross-tenant access is not permitted for this account');
      }
      this.setEffectiveTenant(r, user.tenantId ?? undefined);
      return next();
    }

    // ---- SUPER_ADMIN acting-as a tenant ----
    if (!requested) {
      // Platform/system scope — no tenant selected. Tenant-scoped ops fail closed
      // downstream (RLS denies, TenantGuard/resolvers reject) rather than silently
      // returning another tenant's or empty data.
      this.setEffectiveTenant(r, user.tenantId ?? undefined);
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
        'CRITICAL: no TENANT_ACTIVE_CHECK provider registered — cannot validate SUPER_ADMIN act-as in production.',
      );
    }

    // MFA step-up for cross-tenant access (mirrors TenantGuard policy).
    const homeTenantId = user.tenantId ?? null;
    const isCrossTenant = requested !== homeTenantId;
    const mfaVerified = user.mfaVerified === true;
    if (isCrossTenant && process.env['MFA_REQUIRED_FOR_CROSS_TENANT'] !== 'false' && !mfaVerified) {
      throw new ForbiddenException('MFA step-up is required for cross-tenant access');
    }

    if (isCrossTenant) {
      // ADR-0007: cross-tenant operator access is justified, not silent. The
      // reason and ticket travel in the signed assertion and land on every
      // audit row the downstream write produces.
      r.actAs = {
        homeTenantId,
        targetTenantId: requested,
        reason: this.requireReason(r.requestedActAsReason),
        ticket: this.validateTicket(r.requestedActAsTicket),
        mfaVerified,
      };
    }

    this.setEffectiveTenant(r, requested);
    if (isCrossTenant) {
      // Cross-tenant access is a security-relevant event — surface it. (The
      // signed assertion carries effectiveTenantId + act-as claims; downstream
      // services audit per-operation.)
      this.logger.log(
        JSON.stringify({
          event: 'super_admin_cross_tenant_context_resolved',
          mfaVerified,
          hasTicket: r.actAs?.ticket !== null,
        }),
      );
    }
    next();
  }

  private requireReason(reason: string | undefined): string {
    if (!reason) {
      throw new ForbiddenException(
        `Cross-tenant access requires a justification in the ${ACT_AS_REASON_HEADER} header`,
      );
    }
    if (reason.length > ACT_AS_REASON_MAX_LENGTH) {
      throw new ForbiddenException(
        `${ACT_AS_REASON_HEADER} must be at most ${ACT_AS_REASON_MAX_LENGTH} characters`,
      );
    }
    return reason;
  }

  private validateTicket(ticket: string | undefined): string | null {
    if (ticket === undefined) return null;
    if (ticket.length > ACT_AS_TICKET_MAX_LENGTH || !ACT_AS_TICKET_PATTERN.test(ticket)) {
      throw new ForbiddenException(
        `${ACT_AS_TICKET_HEADER} must be a ticket reference of at most ${ACT_AS_TICKET_MAX_LENGTH} characters`,
      );
    }
    return ticket;
  }
}
