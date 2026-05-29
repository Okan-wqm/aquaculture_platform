import {
  Injectable,
  CanActivate,
  ExecutionContext,
  BadRequestException,
  ForbiddenException,
  Inject,
  Logger,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { GqlExecutionContext } from '@nestjs/graphql';

// IMPORTANT: import from tokens, NOT from `audit-log.service` / `audit-log.entity`.
// Importing the service would chain through `audit-log.entity` and fire the
// `@Entity()` decorator on every backend-common consumer, polluting TypeORM's
// global metadata storage and surfacing as cross-service drift on services
// that never opted into audit logging (DEFECT-1, INFRA-CRITICAL-021).
import { AUDIT_LOG_SERVICE, AuditSeverity, type IAuditLogService } from '../audit/audit-log.tokens';
import { SKIP_TENANT_GUARD_KEY, IS_PUBLIC_KEY, Role } from '../decorators/roles.decorator';
import { TenantRequest } from '../types/tenant-request.interface';

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
 *   **SUPER_ADMIN** — May impersonate a specific tenant via the dedicated
 *   `X-Act-As-Tenant` header. This header is validated for UUID format and
 *   audit-logged with userId, source tenant, target tenant, endpoint, and
 *   timestamp. The generic X-Tenant-Id header is NOT accepted even for super
 *   admins to maintain a single, auditable impersonation vector.
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

  /** Whether MFA step-up is required for SUPER_ADMIN cross-tenant access. */
  private readonly mfaRequiredForCrossTenant: boolean;

  // WHY: Explicit @Inject() — design:paramtypes may not survive all build/runtime environments
  // (Alpine musl, prod-only deps). Belt-and-suspenders for NestJS DI resolution.
  // The audit dependency uses the AUDIT_LOG_SERVICE token + IAuditLogService
  // interface (NOT the concrete class) so this guard never imports the
  // `AuditLogEntity` decorator, even transitively. Services that wire
  // `AuditLogModule.forRoot()` provide the token; services that don't get
  // `undefined` and fall back to ephemeral `logger.warn()`.
  constructor(
    @Inject(Reflector) private reflector: Reflector,
    @Optional() @Inject(AUDIT_LOG_SERVICE) private readonly auditLogService?: IAuditLogService,
    @Optional() @Inject(ConfigService) private readonly configService?: ConfigService,
  ) {
    this.mfaRequiredForCrossTenant =
      this.configService?.get<string>('MFA_REQUIRED_FOR_CROSS_TENANT', 'true') === 'true';

    if (!this.auditLogService) {
      this.logger.warn(
        'AuditLogService not available — SUPER_ADMIN cross-tenant access will only be logged ephemerally',
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

    const contextType = context.getType<string>();
    let request: TenantRequest;

    if (contextType === 'graphql') {
      const gqlCtx = GqlExecutionContext.create(context);
      const gqlRequestContext = gqlCtx.getContext<{ req: TenantRequest }>();
      request = gqlRequestContext.req;
    } else {
      request = context.switchToHttp().getRequest<TenantRequest>();
    }

    const user = request.user;

    // ---------------------------------------------------------------
    // SUPER_ADMIN: operates in system scope, no tenant enforcement.
    // May impersonate a tenant via the dedicated X-Act-As-Tenant header.
    //
    // SECURITY (H-13): Cross-tenant access is mandatory audit-logged.
    // ---------------------------------------------------------------
    if (this.isSuperAdmin(user)) {
      const actAsTenant = this.extractActAsTenantHeader(request);
      if (actAsTenant) {
        if (!UUID_REGEX.test(actAsTenant)) {
          throw new BadRequestException('X-Act-As-Tenant header must be a valid UUID');
        }

        const sourceTenantId =
          request.farmVerifiedIdentity?.actorTenantId ?? user?.tenantId ?? 'system';
        const isCrossTenant = actAsTenant !== sourceTenantId;

        // SECURITY (H-13): MFA step-up enforcement for cross-tenant access
        if (isCrossTenant) {
          this.enforceMfaStepUp(user);
        }

        request.tenantId = actAsTenant;

        // SECURITY (H-13 + BULGU-4): Persistent audit logging for cross-tenant access.
        // Critical security events MUST be awaited to prevent silent audit loss.
        if (isCrossTenant) {
          await this.auditCrossTenantAccess(request, user, sourceTenantId, actAsTenant);
        }
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
  private enforceMfaStepUp(user: TenantRequest['user']): void {
    if (!this.mfaRequiredForCrossTenant) {
      return;
    }

    if (!user?.mfaVerified) {
      this.logger.warn('SUPER_ADMIN cross-tenant access denied: MFA not verified', {
        userId: user?.sub,
      });
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
   * If AuditLogService is unavailable or the awaited write fails, production
   * requests fail closed. Non-production keeps ephemeral logging so partial
   * local service modules can still be exercised.
   */
  private async auditCrossTenantAccess(
    request: TenantRequest,
    user: TenantRequest['user'],
    sourceTenantId: string,
    targetTenantId: string,
  ): Promise<void> {
    const endpoint = `${request.method} ${request.url}`;
    const timestamp = new Date().toISOString();
    const ip = this.extractClientIp(request);
    const userAgent =
      typeof request.headers['user-agent'] === 'string' ? request.headers['user-agent'] : undefined;

    // Always emit an ephemeral log for real-time observability
    this.logger.warn('SUPER_ADMIN cross-tenant access', {
      userId: user?.sub,
      sourceTenantId,
      targetTenantId,
      endpoint,
      timestamp,
    });

    // Persist to audit trail via AuditLogService (awaited for critical events).
    // Production farm/admin surfaces fail closed if the durable audit row cannot
    // be written; non-production keeps the historical graceful degradation for
    // local testing and partial service modules.
    if (!this.auditLogService) {
      if (this.isProduction()) {
        throw new ForbiddenException('Cross-tenant audit logging is unavailable. Access denied.');
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
          mfaVerified: user?.mfaVerified ?? false,
        },
        ip: ip ?? null,
        userAgent: userAgent ?? null,
        severity: AuditSeverity.WARNING,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        'Critical audit write failed for SUPER_ADMIN cross-tenant access: ' + message,
        { userId: user?.sub, sourceTenantId, targetTenantId, endpoint },
      );
      if (this.isProduction()) {
        throw new ForbiddenException('Cross-tenant audit logging failed. Access denied.');
      }
    }
  }

  private isProduction(): boolean {
    return (
      this.configService?.get<string>('NODE_ENV', process.env['NODE_ENV'] ?? 'development') ===
      'production'
    );
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
   * Extract the target tenant for SUPER_ADMIN impersonation.
   *
   * SECURITY (C-04): Farm's preferred source is the gateway-signed verified
   * user assertion. The legacy raw X-Act-As-Tenant header remains supported
   * for unit tests and older internal callers, but the farm gateway path no
   * longer forwards it as the authority.
   */
  private extractActAsTenantHeader(request: TenantRequest): string | undefined {
    const identity = request.farmVerifiedIdentity;
    const actorTenantId = identity?.actorTenantId ?? request.user?.tenantId;
    if (
      identity?.effectiveTenantId &&
      (!actorTenantId || identity.effectiveTenantId !== actorTenantId)
    ) {
      return identity.effectiveTenantId;
    }

    if (identity) {
      return undefined;
    }

    const header = request.headers['x-act-as-tenant'];
    return typeof header === 'string' ? header : undefined;
  }
}
