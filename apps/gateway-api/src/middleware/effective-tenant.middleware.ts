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
  Inject,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { isLoginAllowed, TenantStatus } from '@platform/event-contracts';
import { getRequestContext } from '@aquaculture/backend-common/logging';
import {
  buildGatewayVerifiedUserAssertion,
  requireCanonicalGatewayAssertionRoles,
} from '@aquaculture/backend-common/http';
import type { Request, Response, NextFunction } from 'express';
import {
  IMPERSONATION_CREDENTIAL_HEADER,
  IMPERSONATION_AUTHORIZATION_RECEIPT_VERSION,
  IMPERSONATION_SESSION_HEADER,
  canonicalWireJsonContentSha256V1,
  compileImpersonationAuthorizationOperationsV1,
  isImpersonationAuthorizationHttpMethod,
  isImpersonationContextId,
  isImpersonationCredential,
  sha256Hex,
  type ImpersonationPermissionsContract,
} from '@aquaculture/shared-contracts';

import { JwtPayload } from '../guards/auth.guard';
import { TenantLookupService } from '../services/tenant-lookup.service';
import { ImpersonationAuthorizationService } from '../services/impersonation-authorization.service';
import type { ImpersonationOperationAuthorizer } from '../types';
import {
  assertImpersonationGraphqlEnvelope,
  enforceImpersonationOperations,
} from '../security/impersonation-operation-authority';
import {
  commitImpersonationOperationReceipt,
  initializeImpersonationReceiptLedger,
} from '../security/impersonation-receipt-completion';
import {
  assertImpersonationRouteContent,
  resolveImpersonationGatewayRouteConsumer,
} from '../security/impersonation-route-consumer-catalog';

/**
 * Minimal port the middleware depends on (abstraction, not the concrete service)
 * so the active-tenant check is trivially mockable. The concrete
 * TenantLookupService is structurally assignable and injected by token below.
 */
export interface TenantActiveCheck {
  lookupTenant(tenantId: string): Promise<{ status: TenantStatus } | null>;
}

// Browser-supplied act-as intent, in precedence order. Both are stripped by
// StripInternalHeadersMiddleware — captured here only as an INTENT to validate.
const ACT_AS_HEADERS = ['x-act-as-tenant', 'x-tenant-id'] as const;

/** Express request augmented with the resolved tenant-context SSoT fields. */
export interface RequestWithEffectiveTenant extends Request {
  user?: JwtPayload & { mfaVerified?: boolean };
  /** Untrusted browser act-as intent, captured pre-strip. */
  requestedActAsTenant?: string;
  /** Untrusted opaque credential, captured before internal-header stripping. */
  requestedImpersonationToken?: string;
  /** Untrusted hand-off session coordinate, captured before header stripping. */
  requestedImpersonationSessionId?: string;
  /** Gateway-minted once per external request and reused only for internal retry. */
  authorizationReceiptId?: string;
  /** The single resolved, authority-validated effective tenant (the SSoT). */
  effectiveTenantId?: string;
  impersonationSessionId?: string;
  impersonationPermissions?: ImpersonationPermissionsContract;
  authorizeImpersonationOperations?: ImpersonationOperationAuthorizer;
  impersonationRouteConsumerId?: string;
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
    r.authorizationReceiptId = randomUUID();
    for (const header of ACT_AS_HEADERS) {
      const value = req.headers[header];
      if (typeof value === 'string' && value.length > 0) {
        r.requestedActAsTenant = value;
        break;
      }
    }
    const credential = req.headers[IMPERSONATION_CREDENTIAL_HEADER];
    if (typeof credential === 'string' && credential.length > 0) {
      r.requestedImpersonationToken = credential;
    }
    const sessionId = req.headers[IMPERSONATION_SESSION_HEADER];
    if (typeof sessionId === 'string' && sessionId.length > 0) {
      r.requestedImpersonationSessionId = sessionId;
    }
    next();
  }
}

function normalizedRequestQuery(req: Request): {
  readonly hash: string;
  readonly hasQueryComponent: boolean;
} {
  const requestTarget = req.originalUrl || req.url;
  const queryStart = requestTarget.indexOf('?');
  if (queryStart === -1) return { hash: sha256Hex(''), hasQueryComponent: false };
  const rawQuery = requestTarget.slice(queryStart + 1);
  if (/%(?![0-9a-f]{2})/iu.test(rawQuery)) {
    throw new TypeError('Impersonation request query contains invalid percent encoding');
  }
  const query = new URLSearchParams(rawQuery);
  const entries = [...query.entries()].sort(([leftKey, leftValue], [rightKey, rightValue]) => {
    if (leftKey !== rightKey) return leftKey < rightKey ? -1 : 1;
    return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
  });
  return {
    hash: sha256Hex(new URLSearchParams(entries).toString()),
    hasQueryComponent: true,
  };
}

function normalizedRequestPath(req: Request): string {
  const requestTarget = req.originalUrl || req.url;
  const queryStart = requestTarget.indexOf('?');
  const path = queryStart === -1 ? requestTarget : requestTarget.slice(0, queryStart);
  if (
    !path.startsWith('/') ||
    path.length > 2_048 ||
    path.includes('%') ||
    path.includes('\\') ||
    path.includes('//') ||
    path.includes('#') ||
    (path.length > 1 && path.endsWith('/')) ||
    /[\u0000-\u0020\u007f]/u.test(path)
  ) {
    throw new TypeError('Impersonation request path is not canonical');
  }
  return path;
}

function normalizedRequestBodyHash(req: Request, content: 'empty' | 'json-object'): string {
  if (content === 'empty') return sha256Hex('');
  return canonicalWireJsonContentSha256V1(req.body, {
    maxDepth: 64,
    maxNodes: 100_000,
    maxBytes: 1_024 * 1_024,
  });
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

  constructor(
    @Inject(TenantLookupService)
    private readonly tenantLookup: TenantActiveCheck,
    @Inject(ImpersonationAuthorizationService)
    private readonly impersonationAuthorization: Pick<
      ImpersonationAuthorizationService,
      'authorizeOperations' | 'resolveContext'
    >,
  ) {}

  /**
   * A.4: set the request's effective tenant AND enrich the AsyncLocalStorage
   * logging frame so every subsequent gateway log line carries the EFFECTIVE
   * tenant. RequestContextMiddleware established the frame earlier from the JWT
   * tenant only; for a SUPER_ADMIN acting-as a tenant the effective tenant
   * differs, and StructuredLoggerService reads ctx.tenantId live at log time.
   * No-op (and safe) when no ALS frame is active.
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
      if (r.requestedImpersonationToken || r.requestedImpersonationSessionId) {
        throw new ForbiddenException('Impersonation credentials require a SUPER_ADMIN session');
      }
      // Regular users: the tenant comes EXCLUSIVELY from the verified JWT claim.
      // A request that tries to act as a DIFFERENT tenant is a cross-tenant
      // escalation attempt — reject it (the header was already stripped; this is
      // belt-and-suspenders).
      if (requested && user.tenantId && requested !== user.tenantId) {
        this.logger.warn(
          JSON.stringify({
            event: 'non_super_admin_cross_tenant_act_as_rejected',
          }),
        );
        throw new ForbiddenException('Cross-tenant access is not permitted for this account');
      }
      this.setEffectiveTenant(r, user.tenantId ?? undefined);
      return next();
    }

    // ---- SUPER_ADMIN acting-as a tenant ----
    if (!requested) {
      if (r.requestedImpersonationToken || r.requestedImpersonationSessionId) {
        throw new ForbiddenException('Impersonation credential requires an explicit target tenant');
      }
      // Platform/system scope — no tenant selected. Tenant-scoped ops fail closed
      // downstream (RLS denies, TenantGuard/resolvers reject) rather than silently
      // returning another tenant's or empty data.
      this.setEffectiveTenant(r, user.tenantId ?? undefined);
      return next();
    }

    if (!isImpersonationContextId(requested)) {
      throw new ForbiddenException('Act-as tenant must be a valid UUID');
    }

    const authorization = req.headers.authorization;
    const credential = r.requestedImpersonationToken;
    const sessionId = r.requestedImpersonationSessionId;
    const authorizationReceiptId = r.authorizationReceiptId;
    if (
      typeof authorization !== 'string' ||
      !authorization.startsWith('Bearer ') ||
      !isImpersonationCredential(credential) ||
      !isImpersonationContextId(sessionId) ||
      !isImpersonationContextId(authorizationReceiptId)
    ) {
      throw new ForbiddenException(
        'Cross-tenant access requires a canonical impersonation credential',
      );
    }
    if (user.mfaVerified !== true) {
      throw new ForbiddenException('MFA step-up is required for cross-tenant access');
    }
    const requestMethod = req.method.toUpperCase();
    if (!isImpersonationAuthorizationHttpMethod(requestMethod)) {
      throw new ForbiddenException('Impersonation request method is not canonical');
    }
    let normalizedPath: string;
    let normalizedQuery: ReturnType<typeof normalizedRequestQuery>;
    try {
      normalizedPath = normalizedRequestPath(req);
      normalizedQuery = normalizedRequestQuery(req);
    } catch {
      throw new ForbiddenException('Impersonation request target is not canonical');
    }
    const routeConsumer = resolveImpersonationGatewayRouteConsumer(requestMethod, normalizedPath);
    if (!routeConsumer) {
      throw new ForbiddenException('This gateway route does not support impersonation');
    }
    try {
      assertImpersonationRouteContent(req, routeConsumer, normalizedQuery.hasQueryComponent);
      if (routeConsumer.consumer === 'federated-graphql') {
        assertImpersonationGraphqlEnvelope(req.body);
      }
    } catch {
      throw new ForbiddenException('Impersonation request content is not canonical');
    }
    const clientIp = req.ip || undefined;
    const clientUserAgent =
      typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : undefined;
    if (!clientIp || !clientUserAgent) {
      throw new ForbiddenException('Impersonation requires canonical client network context');
    }
    let bodyHash: string;
    let verifiedUserAssertion: string;
    try {
      bodyHash = normalizedRequestBodyHash(req, routeConsumer.content);
      verifiedUserAssertion = buildGatewayVerifiedUserAssertion({
        subject: user.sub,
        tenantId: user.tenantId ?? null,
        // This is the pre-authorization actor assertion. The shared assertion
        // contract deliberately forbids claiming a cross-tenant effective
        // identity until a canonical session + permission pair is available.
        // The target remains bound separately by the signed service identity
        // and the typed authorization coordinate below.
        effectiveTenantId: user.tenantId ?? null,
        roles: requireCanonicalGatewayAssertionRoles(user.roles ?? []),
        email: user.email,
        mfaVerified: true,
        assignedSiteIds: user.assignedSiteIds,
        mobileFeatures: user.mobileFeatures,
        resourcePermissions: user.resourcePermissions,
        planLevel: user.planLevel,
        clientIp,
        clientUserAgent,
      });
    } catch {
      throw new ForbiddenException('Impersonation request identity or body is not canonical');
    }
    const authorizationBase = Object.freeze({
      credential,
      authorization,
      verifiedUserAssertion,
      authorizationReceiptId,
      sessionId,
      actorId: user.sub,
      mfaVerified: true,
      targetTenantId: requested,
      method: requestMethod,
      normalizedPath,
      normalizedQueryHash: normalizedQuery.hash,
      bodyHash,
      clientIp,
      clientUserAgent,
    });
    const grant = await this.impersonationAuthorization.resolveContext(authorizationBase);
    if (!grant || grant.superAdminId !== user.sub || grant.targetTenantId !== requested) {
      throw new ForbiddenException('Impersonation credential is invalid for this tenant');
    }
    r.impersonationSessionId = grant.sessionId;
    r.impersonationPermissions = grant.permissions;
    r.impersonationRouteConsumerId = routeConsumer.id;
    initializeImpersonationReceiptLedger(r, routeConsumer.id);

    let authorizationTail: Promise<void> = Promise.resolve();
    const authorizeOperations: ImpersonationOperationAuthorizer = (operationInput) => {
      const run = authorizationTail.then(async () => {
        const operations = compileImpersonationAuthorizationOperationsV1(operationInput);
        if (!operations) {
          throw new ForbiddenException('Impersonation operation set is not canonical');
        }
        enforceImpersonationOperations(grant.permissions, operations);
        const receipt = await this.impersonationAuthorization.authorizeOperations(
          authorizationBase,
          operations,
        );
        if (
          !receipt ||
          receipt.sessionId !== grant.sessionId ||
          receipt.superAdminId !== user.sub ||
          receipt.targetTenantId !== requested
        ) {
          throw new ForbiddenException('Exact impersonation operation authorization was denied');
        }
        commitImpersonationOperationReceipt(r, operations);
      });
      authorizationTail = run;
      return run;
    };
    r.authorizeImpersonationOperations = authorizeOperations;
    Reflect.deleteProperty(r, 'requestedImpersonationToken');

    // Validate the target tenant exists and is ACTIVE. Fail CLOSED in production:
    // a missing lookup service must not let an unvalidated act-as through.
    const tenant = await this.tenantLookup.lookupTenant(requested);
    if (!tenant || !isLoginAllowed(tenant.status)) {
      throw new ForbiddenException('Act-as target tenant is not active');
    }

    // MFA step-up for cross-tenant access (mirrors TenantGuard policy).
    const sourceTenant = user.tenantId ?? null;
    const isCrossTenant = requested !== sourceTenant;
    const mfaRequired =
      process.env['NODE_ENV'] === 'production' ||
      process.env['MFA_REQUIRED_FOR_CROSS_TENANT'] !== 'false';
    if (isCrossTenant && mfaRequired && user.mfaVerified !== true) {
      throw new ForbiddenException('MFA step-up is required for cross-tenant access');
    }

    this.setEffectiveTenant(r, requested);
    if (isCrossTenant) {
      // Cross-tenant access is a security-relevant event — surface it. (The
      // signed assertion carries effectiveTenantId; downstream services audit
      // per-operation.)
      this.logger.log(
        JSON.stringify({
          event: 'super_admin_cross_tenant_context_resolved',
          mfaVerified: user.mfaVerified === true,
        }),
      );
    }
    next();
  }
}
