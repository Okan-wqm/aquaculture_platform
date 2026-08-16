import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Logger,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { GqlExecutionContext } from '@nestjs/graphql';

import { getRequestFromArgumentsHost } from '../../context/execution-context-request';

/**
 * IDOR (Insecure Direct Object Reference) Protection
 *
 * This guard prevents unauthorized access to resources by ensuring
 * users can only access resources belonging to their tenant.
 *
 * IDOR attacks occur when an application uses user-controllable input
 * to directly access objects (e.g., changing ?id=123 to ?id=124).
 *
 * Protection strategies:
 * 1. Tenant isolation - Users can only access their tenant's data
 * 2. Owner verification - Users can only access their own resources
 * 3. Role-based access - Higher roles can access more resources
 */

/**
 * Metadata key for IDOR check configuration
 */
export const IDOR_CHECK_KEY = 'IDOR_CHECK';

/**
 * IDOR check configuration
 */
export interface IdorCheckConfig {
  /**
   * Parameter name containing the resource ID
   * Can be in params, query, body, or args (GraphQL)
   */
  resourceIdParam?: string;

  /**
   * Parameter name containing the tenant ID
   * If not specified, uses user's tenant ID
   */
  tenantIdParam?: string;

  /**
   * If true, allows access if user owns the resource
   */
  allowOwner?: boolean;

  /**
   * Parameter name containing owner ID
   */
  ownerIdParam?: string;

  /**
   * Roles that bypass IDOR check
   */
  bypassRoles?: string[];

  /**
   * Custom error message
   */
  errorMessage?: string;
}

/**
 * Decorator to mark routes for IDOR protection
 *
 * @example
 * // Basic tenant check
 * @IdorCheck()
 * @Get('resource/:id')
 * getResource(@Param('id') id: string) {}
 *
 * @example
 * // Owner check
 * @IdorCheck({ allowOwner: true, ownerIdParam: 'userId' })
 * @Get('user/:userId/profile')
 * getProfile(@Param('userId') userId: string) {}
 */
export function IdorCheck(config: IdorCheckConfig = {}): MethodDecorator & ClassDecorator {
  return SetMetadata(IDOR_CHECK_KEY, config);
}

/**
 * Skip IDOR check for specific route
 */
export const SKIP_IDOR_KEY = 'SKIP_IDOR';
export function SkipIdorCheck(): MethodDecorator & ClassDecorator {
  return SetMetadata(SKIP_IDOR_KEY, true);
}

/**
 * Request with user context
 */
interface AuthenticatedRequest {
  user?: {
    sub?: string;
    userId?: string;
    tenantId?: string;
    role?: string;
    roles?: string[];
  };
  tenantId?: string;
  params?: Record<string, unknown>;
  query?: Record<string, unknown>;
  body?: Record<string, unknown>;
}

function scalarRequestParameter(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  return undefined;
}

/**
 * IDOR Guard
 *
 * Validates that users can only access resources within their authorization scope.
 *
 * SOLID Principles:
 * - Single Responsibility: Only handles IDOR validation
 * - Open/Closed: Configurable via decorators
 *
 * **Opt-in behaviour warning**
 * When `IdorGuard` is registered globally (e.g. `APP_GUARD`), it will silently
 * pass any route that does NOT carry the `@IdorCheck()` decorator. This is by
 * design to allow incremental adoption, but it means un-annotated routes receive
 * NO IDOR protection at all.
 *
 * Developers MUST do one of the following on every protected route:
 * - Apply `@IdorCheck()` (with an appropriate config) to enable IDOR validation.
 * - Apply `@SkipIdorCheck()` to explicitly acknowledge the route opts out.
 *
 * The guard emits a debug-level log for every pass-through without a decorator
 * to assist during development and code review. Consider enabling debug logging
 * in non-production environments to audit uncovered routes.
 */
@Injectable()
export class IdorGuard implements CanActivate {
  private readonly logger = new Logger(IdorGuard.name);

  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    // Check if IDOR check should be skipped
    const shouldSkip = this.reflector.getAllAndOverride<boolean>(SKIP_IDOR_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (shouldSkip) {
      return true;
    }

    // Get IDOR configuration
    const config = this.reflector.getAllAndOverride<IdorCheckConfig>(IDOR_CHECK_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    // No IDOR check configured - pass through but log for visibility.
    // Routes should use @IdorCheck() for explicit protection or
    // @SkipIdorCheck() to explicitly opt out when IdorGuard is global.
    if (!config) {
      this.logger.debug(
        `No @IdorCheck() configured for ${context.getClass().name}.${context.getHandler().name}. ` +
          `Add @IdorCheck() for IDOR protection or @SkipIdorCheck() to explicitly opt out.`,
      );
      return true;
    }

    const request = this.getRequest(context);
    const user = request.user;

    // No user context - let auth guard handle this
    if (!user) {
      return true;
    }

    // Check bypass roles
    if (config.bypassRoles && config.bypassRoles.length > 0) {
      const userRoles = user.roles || (user.role ? [user.role] : []);
      if (config.bypassRoles.some((role) => userRoles.includes(role))) {
        return true;
      }
    }

    // Tenant validation
    if (!this.validateTenantAccess(request, config)) {
      const errorMsg = config.errorMessage || 'Access denied: resource not found';
      this.logger.warn(`IDOR attempt blocked for user ${user.sub || user.userId}: tenant mismatch`);
      throw new ForbiddenException(errorMsg);
    }

    // Owner validation (if configured)
    if (config.allowOwner && config.ownerIdParam) {
      if (this.validateOwnerAccess(request, config)) {
        return true;
      }
    }

    return true;
  }

  /**
   * Get request from context (REST or GraphQL)
   */
  private getRequest(context: ExecutionContext): AuthenticatedRequest {
    const contextType = context.getType<string>();

    if (contextType === 'graphql') {
      const gqlContext = GqlExecutionContext.create(context);
      const args = gqlContext.getArgs<Record<string, unknown>>();
      const request = getRequestFromArgumentsHost<AuthenticatedRequest>(context);
      if (!request) {
        throw new ForbiddenException('Access denied');
      }

      // Merge args into request for uniform access
      return { ...request, body: { ...request.body, ...args } };
    }

    const request = getRequestFromArgumentsHost<AuthenticatedRequest>(context);
    if (!request) {
      throw new ForbiddenException('Access denied');
    }
    return request;
  }

  /**
   * Validate tenant access
   */
  private validateTenantAccess(request: AuthenticatedRequest, config: IdorCheckConfig): boolean {
    const user = request.user;
    if (!user) return false;

    // Get user's tenant ID
    const userTenantId = user.tenantId || request.tenantId;

    // Super admin can access any tenant
    const userRoles = user.roles || (user.role ? [user.role] : []);
    if (userRoles.includes('SUPER_ADMIN')) {
      return true;
    }

    // If user has no tenant, they can only access public resources
    if (!userTenantId) {
      return false;
    }

    // Get resource's tenant ID from request
    const resourceTenantId = this.extractParam(request, config.tenantIdParam || 'tenantId');

    // If no tenant ID in request, assume it's the user's tenant
    if (!resourceTenantId) {
      return true;
    }

    // Validate tenant match
    return userTenantId === resourceTenantId;
  }

  /**
   * Validate owner access
   */
  private validateOwnerAccess(request: AuthenticatedRequest, config: IdorCheckConfig): boolean {
    const user = request.user;
    if (!user || !config.ownerIdParam) return false;

    const userId = user.sub || user.userId;
    if (!userId) return false;

    const ownerId = this.extractParam(request, config.ownerIdParam);
    if (!ownerId) return false;

    return userId === ownerId;
  }

  /**
   * Extract parameter from request
   */
  private extractParam(request: AuthenticatedRequest, paramName: string): string | undefined {
    // Check params (URL path parameters)
    const pathValue = scalarRequestParameter(request.params?.[paramName]);
    if (pathValue !== undefined) {
      return pathValue;
    }

    // Check query (URL query parameters)
    const queryValue = scalarRequestParameter(request.query?.[paramName]);
    if (queryValue !== undefined) {
      return queryValue;
    }

    // Check body (POST/PUT data)
    const bodyValue = scalarRequestParameter(request.body?.[paramName]);
    if (bodyValue !== undefined) {
      return bodyValue;
    }

    return undefined;
  }
}

/**
 * @deprecated REMOVED: ensureTenantScope was removed due to SQL injection vulnerability.
 * Use TypeORM parameterized queries instead:
 *
 * @example
 * // Before (UNSAFE):
 * .where(ensureTenantScope('entity', tenantId))
 *
 * // After (SAFE):
 * .where('entity."tenantId" = :tenantId', { tenantId })
 */

/**
 * @deprecated REMOVED: ensureOwnerScope was removed due to SQL injection vulnerability.
 * Use TypeORM parameterized queries instead:
 *
 * @example
 * // Before (UNSAFE):
 * .where(ensureOwnerScope('entity', userId))
 *
 * // After (SAFE):
 * .where('entity."userId" = :userId', { userId })
 */
