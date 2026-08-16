import {
  Injectable,
  CanActivate,
  ExecutionContext,
  BadRequestException,
  ForbiddenException,
  ServiceUnavailableException,
  Inject,
  Logger,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';

import { AUDIT_LOG_SERVICE, AuditSeverity, type IAuditLogService } from '../audit/audit-log.tokens';
import { getRequestFromArgumentsHost } from '../context/execution-context-request';
import { SKIP_TENANT_GUARD_KEY, IS_PUBLIC_KEY, Role } from '../decorators/roles.decorator';
import { TenantRequest } from '../types/tenant-request.interface';
// IMPORTANT: import from tokens, NOT from `audit-log.service` / `audit-log.entity`.
// Importing the service would chain through `audit-log.entity` and fire the
// `@Entity()` decorator on every backend-common consumer, polluting TypeORM's
// global metadata storage and surfacing as cross-service drift on services
// that never opted into audit logging (DEFECT-1, INFRA-CRITICAL-021).

/** UUID v4 format validator. */
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Tenant Guard — enforces tenant isolation for every authenticated request.
 *
 * SECURITY (C-04): Tenant ID sources have been reduced to the minimum trusted set:
 *
 *   **Regular users** — The ONLY accepted source is `req.user.tenantId`, decoded
 *   from a cryptographically verified JWT by JwtAuthGuard. Query parameters,
 *   request body, and ALL headers (including X-Tenant-Id) are intentionally
 *   excluded. An authenticated user can trivially set any of those values, so
 *   accepting them would allow tenant context spoofing.
 *
 *   **SUPER_ADMIN** — May impersonate a specific tenant only through the
 *   gateway-resolved, HMAC-bound effective-tenant context. Regular subgraphs
 *   consume the verified user assertion; auth-service consumes the verified
 *   gateway service identity because it verifies the user's JWT itself.
 *
 * Skip behaviour:
 * - `@SkipTenantGuard()` skips tenant validation for a single route that
 *   still requires authentication.
 * - `@Public()` marks the endpoint as publicly accessible; TenantGuard
 *   checks both `skipTenantGuard` and `isPublic` metadata so either
 *   decorator is sufficient to bypass tenant validation.
 *
 * SECURITY (H-13): SUPER_ADMIN cross-tenant access is **persistently** audit-logged
 * via AuditLogService with action `SUPER_ADMIN_CROSS_TENANT_ACCESS`. The audit record
 * includes userId, sourceTenantId, targetTenantId, endpoint, timestamp, client IP,
 * and user agent. An ephemeral logger.warn() is also emitted for real-time observability.
 *
 * MFA Step-Up: SUPER_ADMIN cross-tenant access requires `mfaVerified: true` in the JWT
 * claims by default (`MFA_REQUIRED_FOR_CROSS_TENANT` defaults to `'true'`).
 * Set `MFA_REQUIRED_FOR_CROSS_TENANT=false` to opt out during MFA rollout.
 */
@Injectable()
export class TenantGuard implements CanActivate {
  private readonly logger = new Logger(TenantGuard.name);
  private readonly isProduction = process.env['NODE_ENV'] === 'production';

  /** Whether MFA step-up is required for SUPER_ADMIN cross-tenant access. */
  private readonly mfaRequiredForCrossTenant: boolean;

  // WHY: Explicit @Inject() — design:paramtypes may not survive all build/runtime environments
  // (Alpine musl, prod-only deps). Belt-and-suspenders for NestJS DI resolution.
  // The audit dependency uses the AUDIT_LOG_SERVICE token + IAuditLogService
  // interface (NOT the concrete class) so this guard never imports the
  // `AuditLogEntity` decorator, even transitively. Services that wire
  // `AuditLogModule.forRoot()` provide the token. Production cross-tenant
  // requests fail closed if that mandatory append capability is unavailable.
  constructor(
    @Inject(Reflector) private reflector: Reflector,
    @Optional() @Inject(AUDIT_LOG_SERVICE) private readonly auditLogService?: IAuditLogService,
    @Optional() @Inject(ConfigService) private readonly configService?: ConfigService,
  ) {
    this.mfaRequiredForCrossTenant =
      this.configService?.get<string>('MFA_REQUIRED_FOR_CROSS_TENANT', 'true') !== 'false';

    if (!this.auditLogService) {
      this.logger.warn(
        JSON.stringify({
          event: 'cross_tenant_audit_capability_unavailable',
          productionFailClosed: this.isProduction,
        }),
      );
    }
  }

  /**
   * Evaluate tenant isolation rules for the current request.
   *
   * SECURITY (ONEMLI-05): Signature is `async` because cross-tenant audit
   * logging for SUPER_ADMIN must be awaited to guarantee persistence of
   * critical security events. NestJS guards fully support both sync
   * (`boolean`) and async (`Promise<boolean>`) return types.
   */
  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Skip if endpoint is marked public
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    // Skip if explicitly annotated with @SkipTenantGuard()
    const skipGuard = this.reflector.getAllAndOverride<boolean>(SKIP_TENANT_GUARD_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (skipGuard) {
      return true;
    }

    const request = getRequestFromArgumentsHost<TenantRequest>(context);
    if (!request) {
      throw new ForbiddenException('Access denied');
    }

    const user = request.user;

    // ---------------------------------------------------------------
    // SUPER_ADMIN: operates in system scope, no tenant enforcement.
    // A tenant impersonation target must come from the gateway's verified
    // assertion, or from the HMAC-bound effective tenant on auth's direct
    // JWT-verification path.
    //
    // SECURITY (H-13): Cross-tenant access is mandatory audit-logged.
    // ---------------------------------------------------------------
    if (this.isSuperAdmin(user)) {
      const actAs = this.resolveTrustedActAs(request, user);
      if (actAs) {
        const isCrossTenant = actAs.targetTenantId !== actAs.sourceTenantId;

        // SECURITY (H-13): MFA step-up enforcement for cross-tenant access
        if (isCrossTenant) {
          this.enforceMfaStepUp(actAs.mfaVerified);
        }

        // SECURITY (H-13 + BULGU-4): Persistent audit logging for cross-tenant access.
        // Critical security events MUST be awaited to prevent silent audit loss.
        if (isCrossTenant) {
          await this.auditCrossTenantAccess(
            request,
            user,
            actAs.sourceTenantId,
            actAs.targetTenantId,
            actAs.clientIp,
            actAs.clientUserAgent,
            actAs.mfaVerified,
          );
        }

        // Publish the tenant context only after all mandatory security checks
        // and the production audit append have succeeded.
        request.tenantId = actAs.targetTenantId;
      }
      return true;
    }

    // ---------------------------------------------------------------
    // Regular users: tenant ID comes EXCLUSIVELY from the JWT claim.
    // Headers, query params, and body are never consulted.
    // ---------------------------------------------------------------
    const tenantId = user?.tenantId;

    if (!tenantId) {
      throw new BadRequestException(
        'Tenant ID is required. The JWT must contain a valid tenantId claim.',
      );
    }

    if (!UUID_REGEX.test(tenantId)) {
      throw new BadRequestException('Tenant ID must be a valid UUID');
    }

    // Store validated tenant ID in request for downstream consumers
    request.tenantId = tenantId;

    return true;
  }

  /**
   * Check if the user has SUPER_ADMIN role.
   * Supports both the `roles` array and the deprecated `role` string field.
   */
  private isSuperAdmin(user?: TenantRequest['user']): boolean {
    if (!user) return false;
    if (user.roles?.includes(Role.SUPER_ADMIN)) return true;
    if (user.role === Role.SUPER_ADMIN) return true;
    return false;
  }

  /**
   * Enforce MFA step-up for SUPER_ADMIN cross-tenant access.
   *
   * When the environment variable MFA_REQUIRED_FOR_CROSS_TENANT is set to 'true',
   * the JWT must contain `mfaVerified: true` for the request to proceed.
   * This prevents a compromised SUPER_ADMIN session (without MFA) from
   * accessing other tenants' data.
   *
   * @throws ForbiddenException if MFA is required but not verified
   */
  private enforceMfaStepUp(mfaVerified: boolean): void {
    if (!this.mfaRequiredForCrossTenant) {
      return;
    }

    if (!mfaVerified) {
      this.logger.warn(
        JSON.stringify({
          event: 'super_admin_cross_tenant_access_denied',
          reason: 'mfa_not_verified',
        }),
      );
      throw new ForbiddenException(
        'MFA verification is required for cross-tenant access. ' +
          'Please complete MFA step-up authentication before accessing another tenant.',
      );
    }
  }

  /**
   * Persist an audit record for SUPER_ADMIN cross-tenant access.
   *
   * SECURITY (H-13 + BULGU-4): This method uses `recordAwait()` so the
   * audit write is awaited before the request proceeds. Cross-tenant access
   * by a SUPER_ADMIN is a critical security event — fire-and-forget is
   * unacceptable because a silent DB failure would leave no forensic trail.
   *
   * The record includes:
   * - userId: the SUPER_ADMIN performing the action
   * - sourceTenantId: the admin's own tenant (or 'system')
   * - targetTenantId: the tenant being accessed
   * - endpoint: HTTP method + URL
   * - timestamp: ISO 8601 timestamp
   * - client IP and user agent for forensic traceability
   *
   * Production fails closed if the service is missing or the append fails;
   * otherwise a privileged mutation could succeed without a forensic record.
   * Non-production keeps an ephemeral fallback for isolated unit/E2E harnesses.
   */
  private async auditCrossTenantAccess(
    request: TenantRequest,
    user: TenantRequest['user'],
    sourceTenantId: string,
    targetTenantId: string,
    assertedClientIp: string | undefined,
    assertedClientUserAgent: string | undefined,
    mfaVerified: boolean,
  ): Promise<void> {
    const endpoint = `${request.method} ${request.url}`;
    const timestamp = new Date().toISOString();
    const ip = assertedClientIp ?? this.extractClientIp(request);
    const userAgent =
      assertedClientUserAgent ??
      (typeof request.headers['user-agent'] === 'string'
        ? request.headers['user-agent']
        : undefined);

    // Always emit an ephemeral log for real-time observability
    this.logger.warn(
      JSON.stringify({
        event: 'super_admin_cross_tenant_access',
        mfaVerified,
      }),
    );

    // Persist to audit trail via AuditLogService (awaited for critical events)
    if (!this.auditLogService) {
      if (this.isProduction) {
        throw new ServiceUnavailableException('Cross-tenant audit trail is unavailable');
      }
      return;
    }

    try {
      await this.auditLogService.recordAwait({
        action: 'SUPER_ADMIN_CROSS_TENANT_ACCESS',
        resource: 'TenantGuard',
        resourceId: targetTenantId,
        userId: user?.sub ?? null,
        userEmail: user?.email ?? null,
        tenantId: targetTenantId,
        metadata: {
          sourceTenantId,
          targetTenantId,
          endpoint,
          timestamp,
          mfaVerified,
        },
        actorHomeTenantId: sourceTenantId === 'system' ? null : sourceTenantId,
        actedOnTenantId: targetTenantId,
        mfaVerified,
        ip: ip ?? null,
        userAgent: userAgent ?? null,
        severity: AuditSeverity.WARNING,
      });
    } catch (err: unknown) {
      this.logger.error(
        JSON.stringify({
          event: 'super_admin_cross_tenant_audit_failed',
          errorType: err instanceof Error ? err.name : 'UnknownError',
        }),
      );
      if (this.isProduction) {
        throw new ServiceUnavailableException('Cross-tenant audit trail is unavailable');
      }
    }
  }

  /**
   * Resolve the single trusted SUPER_ADMIN tenant target.
   *
   * The verified assertion is authoritative in regular subgraphs. Auth-service
   * verifies the access JWT itself, so it consumes the HMAC-bound effective
   * tenant from the verified gateway service identity. Raw browser headers are
   * never trusted in production.
   */
  private resolveTrustedActAs(
    request: TenantRequest,
    user: TenantRequest['user'],
  ):
    | {
        sourceTenantId: string;
        targetTenantId: string;
        mfaVerified: boolean;
        clientIp?: string;
        clientUserAgent?: string;
      }
    | undefined {
    const assertion = request.verifiedUserAssertion;
    const rawActAs = this.extractActAsTenantHeader(request);

    if (assertion) {
      if (
        assertion.issuer !== 'gateway-api' ||
        assertion.subject !== user?.sub ||
        !assertion.roles.includes(Role.SUPER_ADMIN)
      ) {
        throw new ForbiddenException('Verified user assertion does not match authenticated user');
      }

      const targetTenantId = assertion.effectiveTenantId ?? undefined;
      if (!targetTenantId) {
        if (rawActAs) {
          throw new ForbiddenException('Act-as tenant conflicts with verified user assertion');
        }
        return undefined;
      }
      this.assertValidActAsTenant(targetTenantId);
      if (rawActAs && rawActAs !== targetTenantId) {
        throw new ForbiddenException('Act-as tenant conflicts with verified user assertion');
      }
      this.assertGatewayIdentityMatchesTarget(request, targetTenantId);

      return {
        sourceTenantId: assertion.tenantId ?? 'system',
        targetTenantId,
        mfaVerified: assertion.mfaVerified,
        clientIp: assertion.clientIp ?? undefined,
        clientUserAgent: assertion.clientUserAgent ?? undefined,
      };
    }

    const identityTarget =
      request.verifiedIdentity?.serviceName === 'gateway-api'
        ? request.verifiedIdentity.effectiveTenantId
        : undefined;
    if (identityTarget) {
      this.assertValidActAsTenant(identityTarget);
      if (rawActAs && rawActAs !== identityTarget) {
        throw new ForbiddenException('Act-as tenant conflicts with verified gateway identity');
      }
      this.assertGatewayIdentityMatchesTarget(request, identityTarget);
      return {
        sourceTenantId: user?.tenantId ?? 'system',
        targetTenantId: identityTarget,
        mfaVerified: user?.mfaVerified === true,
      };
    }

    if (!rawActAs) {
      return undefined;
    }

    this.assertValidActAsTenant(rawActAs);
    this.assertGatewayIdentityMatchesTarget(request, rawActAs);
    return {
      sourceTenantId: user?.tenantId ?? 'system',
      targetTenantId: rawActAs,
      mfaVerified: user?.mfaVerified === true,
    };
  }

  private assertValidActAsTenant(tenantId: string): void {
    if (!UUID_REGEX.test(tenantId)) {
      throw new BadRequestException('X-Act-As-Tenant header must be a valid UUID');
    }
  }

  private assertGatewayIdentityMatchesTarget(request: TenantRequest, targetTenantId: string): void {
    const identity = request.verifiedIdentity;
    if (!identity) {
      if (this.isProduction) {
        throw new ForbiddenException('Cross-tenant access requires a verified gateway identity');
      }
      return;
    }

    if (
      identity.serviceName !== 'gateway-api' ||
      identity.tenantId !== targetTenantId ||
      identity.effectiveTenantId !== targetTenantId
    ) {
      throw new ForbiddenException('Cross-tenant target does not match verified gateway identity');
    }
  }

  /**
   * Extract the client IP address from the request.
   *
   * SECURITY (BULGU-7): Prefer Express `request.ip` which respects the
   * application-level `trust proxy` configuration. When trust proxy is
   * properly set, Express parses X-Forwarded-For securely and returns
   * the correct client IP. Falling back to raw X-Forwarded-For header
   * only when `request.ip` is unavailable ensures IP spoofing is
   * prevented in environments where trust proxy is configured.
   */
  private extractClientIp(request: TenantRequest): string | undefined {
    // Prefer Express request.ip which respects trust proxy configuration
    if (request.ip) {
      return request.ip;
    }
    // Fallback to X-Forwarded-For header
    const forwarded = request.headers['x-forwarded-for'];
    if (typeof forwarded === 'string') {
      return forwarded.split(',')[0]?.trim();
    }
    return undefined;
  }

  /**
   * Extract the X-Act-As-Tenant header for SUPER_ADMIN tenant impersonation.
   *
   * SECURITY (C-04): This is the ONLY mechanism for super admins to specify a
   * target tenant. The generic X-Tenant-Id header, query params, and request
   * body are intentionally excluded to maintain a single auditable impersonation
   * vector and eliminate confusion with attacker-controlled inputs.
   */
  private extractActAsTenantHeader(request: TenantRequest): string | undefined {
    const header = request.headers['x-act-as-tenant'];
    return typeof header === 'string' ? header : undefined;
  }
}
