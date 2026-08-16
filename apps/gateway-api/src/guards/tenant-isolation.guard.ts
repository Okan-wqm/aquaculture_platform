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
import { Role } from '@platform/identity';

import type { GqlContext, TenantContext } from '../types';

/** Minimal identity/request contract consumed by this guard. */
export interface TenantIsolationUser {
  readonly sub: string;
  readonly tenantId?: string | null;
  readonly roles?: readonly string[];
  readonly role?: string;
  readonly tenantName?: string;
  readonly plan?: string;
  readonly modules?: readonly string[];
  readonly tenantActive?: boolean;
}

export interface TenantIsolationRequest {
  user?: TenantIsolationUser;
  effectiveTenantId?: string;
  tenantId?: string;
  tenantContext?: TenantContext;
}

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
 * Enforces strict tenant isolation across all requests.
 */
@Injectable()
export class TenantIsolationGuard implements CanActivate {
  private readonly logger = new Logger(TenantIsolationGuard.name);

  // WHY: Explicit @Inject() — design:paramtypes may not survive all build/runtime environments.
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

    // System-scope admin endpoints may intentionally have no tenant. Use the
    // canonical role identity; legacy lower-case aliases confer no authority.
    const userRoles = Array.isArray(user.roles) ? user.roles : user.role ? [user.role] : [];
    if (isAdminEndpoint && userRoles.includes(Role.SUPER_ADMIN)) {
      return true;
    }

    // EffectiveTenantMiddleware is the sole cross-tenant resolver. A normal
    // account falls back to its verified JWT tenant for API-key/basic flows
    // that are authenticated by the guard after middleware execution. No
    // request header, query, body, parameter or host is read here.
    const effectiveTenantId = request.effectiveTenantId ?? user.tenantId;
    if (!effectiveTenantId) {
      this.logger.error('Request has no authority-resolved tenant', { userId: user.sub });
      throw new ForbiddenException('A validated tenant context is required');
    }

    if (!this.isValidTenantId(effectiveTenantId)) {
      this.logger.error('Authority resolved an invalid tenant identifier', {
        userId: user.sub,
        tenantId: effectiveTenantId.substring(0, 50),
      });
      throw new ForbiddenException('Invalid tenant context');
    }

    const isSuperAdmin = userRoles.includes(Role.SUPER_ADMIN);
    if (user.tenantId && effectiveTenantId !== user.tenantId && !isSuperAdmin) {
      this.logger.warn('Non-admin request reached isolation with a divergent effective tenant', {
        userId: user.sub,
      });
      throw new ForbiddenException('Access denied to requested tenant');
    }
    if (!user.tenantId && !isSuperAdmin) {
      throw new ForbiddenException('User is not associated with any tenant');
    }

    request.tenantId = effectiveTenantId;
    request.tenantContext = this.buildTenantContext(effectiveTenantId, user);

    return true;
  }

  /**
   * Get request from execution context (supports HTTP and GraphQL)
   */
  private getRequest(context: ExecutionContext): TenantIsolationRequest {
    const contextType = context.getType<string>();

    if (contextType === 'graphql') {
      const gqlContext = GqlExecutionContext.create(context);
      const ctx = gqlContext.getContext<GqlContext>();
      return ctx.req;
    }

    return context.switchToHttp().getRequest<TenantIsolationRequest>();
  }

  /**
   * Build tenant context from user and tenant ID
   */
  private buildTenantContext(tenantId: string, user: TenantIsolationUser): TenantContext {
    return {
      tenantId,
      tenantName: user.tenantName,
      plan: user.plan,
      modules: [...(user.modules ?? [])],
      isActive: user.tenantActive !== false,
    };
  }

  /**
   * Validate tenant ID format
   */
  isValidTenantId(tenantId: string): boolean {
    if (!tenantId) {
      return false;
    }

    // UUID format validation
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    return uuidRegex.test(tenantId);
  }

  /**
   * Get tenant context from request
   */
  static getTenantContext(request: TenantIsolationRequest): TenantContext | null {
    return request.tenantContext ?? null;
  }

  /**
   * Get tenant ID from request
   */
  static getTenantId(request: TenantIsolationRequest): string | null {
    return request.tenantId ?? null;
  }
}
