/**
 * Tenant Isolation Guard
 *
 * Ensures complete data isolation between tenants.
 * Validates tenant context and prevents cross-tenant access.
 * Enterprise-grade with audit logging and strict enforcement.
 */

import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
  Logger,
  SetMetadata,
  Inject,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { GqlExecutionContext } from '@nestjs/graphql';

import {
  AuthenticatedRequest,
  AuthenticatedUser,
  TenantContext,
  GqlContext,
} from '../types';

/**
 * Metadata key for public endpoints (no tenant required)
 */
export const IS_PUBLIC_KEY = 'isPublic';

/**
 * Decorator for public endpoints
 */
export const Public = (): ReturnType<typeof SetMetadata> => SetMetadata(IS_PUBLIC_KEY, true);

/**
 * Metadata key for admin-only endpoints (can access any tenant)
 */
export const IS_ADMIN_KEY = 'isAdmin';

/**
 * Decorator for admin endpoints
 */
export const AdminOnly = (): ReturnType<typeof SetMetadata> => SetMetadata(IS_ADMIN_KEY, true);

/**
 * Re-export TenantContext for consumers
 */
export type { TenantContext };

/**
 * Tenant Isolation Guard
 * Enforces strict tenant isolation across all requests
 *
 * NOTE: Explicit @Inject() decorators are required because Nx webpack (SWC loader)
 * strips TypeScript emitDecoratorMetadata (design:paramtypes) during bundling.
 */
@Injectable()
export class TenantIsolationGuard implements CanActivate {
  private readonly logger = new Logger(TenantIsolationGuard.name);

  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    // Check if endpoint is public
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    const request = this.getRequest(context);

    // Check if admin-only endpoint
    const isAdminEndpoint = this.reflector.getAllAndOverride<boolean>(IS_ADMIN_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    // Get authenticated user
    const user = request.user;
    if (!user) {
      throw new UnauthorizedException('Authentication required');
    }

    // Admin users can access any tenant if it's an admin endpoint.
    // Normalise to array — JWT always issues roles as an array; user.role
    // (singular) was a legacy field that no longer appears in new tokens.
    const userRoles = Array.isArray(user.roles) ? user.roles : (user.role ? [user.role] : []);
    if (isAdminEndpoint && userRoles.includes('admin')) {
      return true;
    }

    // Get tenant ID from various sources
    const requestedTenantId = this.extractRequestedTenantId(request);
    const userTenantId = user.tenantId;

    // Validate user's tenant association
    if (!userTenantId) {
      this.logger.error('User has no tenant association', { userId: user.sub });
      throw new ForbiddenException('User is not associated with any tenant');
    }

    // SECURITY: Validate the user's tenant ID format from JWT
    // This catches malformed tokens that somehow passed JWT validation
    if (!this.isValidTenantId(userTenantId)) {
      this.logger.error('User has invalid tenant ID format in token', {
        userId: user.sub,
        tenantId: userTenantId?.substring(0, 50),
      });
      throw new ForbiddenException('Invalid tenant association');
    }

    // If no specific tenant requested, use user's tenant
    if (!requestedTenantId) {
      request.tenantId = userTenantId;
      request.tenantContext = this.buildTenantContext(userTenantId, user);
      return true;
    }

    // Validate cross-tenant access
    if (requestedTenantId !== userTenantId) {
      // Check if user has cross-tenant access
      if (!this.hasCrossTenantAccess(user, requestedTenantId)) {
        this.logCrossTenantAttempt(user, requestedTenantId);
        throw new ForbiddenException('Access denied to requested tenant');
      }
    }

    // Set tenant context on request
    request.tenantId = requestedTenantId;
    request.tenantContext = this.buildTenantContext(requestedTenantId, user);

    return true;
  }

  /**
   * Get request from execution context (supports HTTP and GraphQL)
   */
  private getRequest(context: ExecutionContext): AuthenticatedRequest {
    const contextType = context.getType<string>();

    if (contextType === 'graphql') {
      const gqlContext = GqlExecutionContext.create(context);
      const ctx = gqlContext.getContext<GqlContext>();
      return ctx.req;
    }

    return context.switchToHttp().getRequest<AuthenticatedRequest>();
  }

  /**
   * Extract and validate requested tenant ID from various sources
   * SECURITY: Validates UUID format to prevent injection attacks
   */
  private extractRequestedTenantId(request: AuthenticatedRequest): string | null {
    let tenantId: string | null = null;

    // Check header (highest priority for API clients)
    const headerTenantId = request.headers['x-tenant-id'];
    if (typeof headerTenantId === 'string' && headerTenantId.length > 0) {
      tenantId = headerTenantId;
    }

    // Check URL parameter (for RESTful routes like /tenants/:tenantId/...)
    if (!tenantId) {
      const paramTenantId = request.params?.['tenantId'];
      if (typeof paramTenantId === 'string' && paramTenantId.length > 0) {
        tenantId = paramTenantId;
      }
    }

    // Check query parameter
    if (!tenantId) {
      const queryTenantId = request.query?.['tenantId'];
      if (typeof queryTenantId === 'string' && queryTenantId.length > 0) {
        tenantId = queryTenantId;
      }
    }

    // Check request body
    if (!tenantId) {
      const body = request.body as Record<string, unknown> | undefined;
      if (body) {
        if (typeof body['tenantId'] === 'string' && body['tenantId'].length > 0) {
          tenantId = body['tenantId'];
        } else {
          // Check GraphQL variables
          const variables = body['variables'] as Record<string, unknown> | undefined;
          if (variables && typeof variables['tenantId'] === 'string' && variables['tenantId'].length > 0) {
            tenantId = variables['tenantId'];
          }
        }
      }
    }

    // SECURITY: Validate tenant ID format if found
    if (tenantId) {
      // Normalize to lowercase for consistent comparison
      const normalizedTenantId = tenantId.toLowerCase().trim();

      if (!this.isValidTenantId(normalizedTenantId)) {
        this.logger.warn('Invalid tenant ID format received', {
          tenantId: tenantId.substring(0, 50), // Truncate for logging
          path: request.url,
          method: request.method,
        });
        throw new ForbiddenException('Invalid tenant identifier');
      }

      return normalizedTenantId;
    }

    return null;
  }

  /**
   * Build tenant context from user and tenant ID
   */
  private buildTenantContext(tenantId: string, user: AuthenticatedUser): TenantContext {
    return {
      tenantId,
      tenantName: user.tenantName,
      plan: user.plan,
      modules: user.modules ?? [],
      isActive: user.tenantActive !== false,
    };
  }

  /**
   * Check if user has cross-tenant access
   */
  private hasCrossTenantAccess(user: AuthenticatedUser, targetTenantId: string): boolean {
    // Normalise to array — eliminates the dual user.roles/user.role check.
    // All JWTs issued after hardening carry roles as an array. Legacy singular
    // user.role is collapsed into the same array for the final check.
    const roles = Array.isArray(user.roles)
      ? user.roles
      : (user.role ? [user.role as string] : []);

    if (roles.includes('platform_admin') || roles.includes('super_admin')) {
      return true;
    }

    // Check explicit tenant access list
    if (user.accessibleTenants && Array.isArray(user.accessibleTenants)) {
      return user.accessibleTenants.includes(targetTenantId);
    }

    // Check partner/reseller access
    if (roles.includes('partner') && user.managedTenants) {
      return user.managedTenants.includes(targetTenantId);
    }

    return false;
  }

  /**
   * Log cross-tenant access attempt for audit
   */
  private logCrossTenantAttempt(user: AuthenticatedUser, targetTenantId: string): void {
    // SECURITY (H-14): Log user ID only -- email is PII and must not appear in logs
    this.logger.warn('Cross-tenant access attempt blocked', {
      userId: user.sub,
      userTenantId: user.tenantId,
      targetTenantId,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Validate tenant ID format
   */
  isValidTenantId(tenantId: string): boolean {
    if (!tenantId) {
      return false;
    }

    // UUID format validation
    const uuidRegex =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    return uuidRegex.test(tenantId);
  }

  /**
   * Get tenant context from request
   */
  static getTenantContext(request: AuthenticatedRequest): TenantContext | null {
    return request.tenantContext ?? null;
  }

  /**
   * Get tenant ID from request
   */
  static getTenantId(request: AuthenticatedRequest): string | null {
    return request.tenantId ?? null;
  }
}
