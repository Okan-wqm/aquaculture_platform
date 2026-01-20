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
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { GqlExecutionContext } from '@nestjs/graphql';

/**
 * Metadata key for public endpoints (no tenant required)
 */
export const IS_PUBLIC_KEY = 'isPublic';

/**
 * Decorator for public endpoints
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

/**
 * Metadata key for admin-only endpoints (can access any tenant)
 */
export const IS_ADMIN_KEY = 'isAdmin';

/**
 * Decorator for admin endpoints
 */
export const AdminOnly = () => SetMetadata(IS_ADMIN_KEY, true);

/**
 * Tenant context for the request
 */
export interface TenantContext {
  tenantId: string;
  tenantName?: string;
  plan?: string;
  modules?: string[];
  isActive: boolean;
}

/**
 * Tenant Isolation Guard
 * Enforces strict tenant isolation across all requests
 */
@Injectable()
export class TenantIsolationGuard implements CanActivate {
  private readonly logger = new Logger(TenantIsolationGuard.name);

  constructor(private readonly reflector: Reflector) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
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

    // Admin users can access any tenant if it's an admin endpoint
    if (isAdminEndpoint && user.role === 'admin') {
      return true;
    }

    // Get tenant ID from various sources
    const requestedTenantId = this.extractRequestedTenantId(request);
    const userTenantId = user.tenantId;

    // Validate tenant context
    if (!userTenantId) {
      this.logger.error('User has no tenant association', { userId: user.sub });
      throw new ForbiddenException('User is not associated with any tenant');
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
  private getRequest(context: ExecutionContext): any {
    const gqlContext = GqlExecutionContext.create(context);
    const gqlRequest = gqlContext.getContext()?.req;

    if (gqlRequest) {
      return gqlRequest;
    }

    return context.switchToHttp().getRequest();
  }

  /**
   * Extract requested tenant ID from various sources
   */
  private extractRequestedTenantId(request: any): string | null {
    // Check header
    const headerTenantId = request.headers?.['x-tenant-id'];
    if (headerTenantId) {
      return headerTenantId;
    }

    // Check query parameter
    const queryTenantId = request.query?.tenantId;
    if (queryTenantId) {
      return queryTenantId;
    }

    // Check URL parameter
    const paramTenantId = request.params?.tenantId;
    if (paramTenantId) {
      return paramTenantId;
    }

    // Check request body
    const bodyTenantId = request.body?.tenantId;
    if (bodyTenantId) {
      return bodyTenantId;
    }

    // Check GraphQL variables
    if (request.body?.variables?.tenantId) {
      return request.body.variables.tenantId;
    }

    return null;
  }

  /**
   * Build tenant context from user and tenant ID
   */
  private buildTenantContext(tenantId: string, user: any): TenantContext {
    return {
      tenantId,
      tenantName: user.tenantName,
      plan: user.plan,
      modules: user.modules || [],
      isActive: user.tenantActive !== false,
    };
  }

  /**
   * Check if user has cross-tenant access
   */
  private hasCrossTenantAccess(user: any, targetTenantId: string): boolean {
    // Platform admins can access any tenant
    if (user.role === 'platform_admin' || user.role === 'super_admin') {
      return true;
    }

    // Check explicit tenant access list
    if (user.accessibleTenants && Array.isArray(user.accessibleTenants)) {
      return user.accessibleTenants.includes(targetTenantId);
    }

    // Check partner/reseller access
    if (user.role === 'partner' && user.managedTenants) {
      return user.managedTenants.includes(targetTenantId);
    }

    return false;
  }

  /**
   * Log cross-tenant access attempt for audit
   */
  private logCrossTenantAttempt(user: any, targetTenantId: string): void {
    this.logger.warn('Cross-tenant access attempt blocked', {
      userId: user.sub,
      userEmail: user.email,
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
  static getTenantContext(request: any): TenantContext | null {
    return request.tenantContext || null;
  }

  /**
   * Get tenant ID from request
   */
  static getTenantId(request: any): string | null {
    return request.tenantId || null;
  }
}
