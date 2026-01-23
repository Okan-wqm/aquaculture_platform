/**
 * Gateway API Shared Types
 *
 * Centralized type definitions for guards, interceptors, middleware, and services.
 * These types ensure type safety across the gateway API.
 */

import { Request, Response } from 'express';

/**
 * JWT payload interface
 */
export interface JwtPayload {
  sub: string; // User ID
  email?: string;
  tenantId: string;
  roles: string[];
  permissions?: string[];
  type: 'access' | 'refresh';
  iat: number;
  exp: number;
  iss?: string;
  aud?: string | string[];
  jti?: string; // JWT ID for blacklisting
}

/**
 * Extended user information available on authenticated requests
 */
export interface AuthenticatedUser extends JwtPayload {
  role?: string;
  tenantName?: string;
  plan?: string;
  modules?: string[];
  tenantActive?: boolean;
  accessibleTenants?: string[];
  managedTenants?: string[];
}

/**
 * Tenant context attached to requests
 */
export interface TenantContext {
  tenantId: string;
  tenantName?: string;
  plan?: string;
  modules?: string[];
  isActive: boolean;
}

/**
 * Authenticated request with user and tenant context
 */
export interface AuthenticatedRequest extends Request {
  user?: AuthenticatedUser;
  authMethod?: 'jwt' | 'api_key' | 'basic';
  apiKey?: string;
  tenantId?: string;
  tenantContext?: TenantContext;
  correlationId?: string;
  startTime?: number;
  deviceFingerprint?: string;
}

/**
 * GraphQL context with request
 */
export interface GqlContext {
  req: AuthenticatedRequest;
  res?: Response;
}

/**
 * API Key information
 */
export interface ApiKeyInfo {
  key?: string;
  userId: string;
  tenantId: string;
  roles: string[];
  permissions?: string[];
  active: boolean;
  expiresAt?: Date;
  name?: string;
}

/**
 * Rate limit configuration per route
 */
export interface RateLimitConfig {
  windowMs: number;
  maxRequests: number;
  message?: string;
}

/**
 * Circuit breaker state
 */
export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

/**
 * Service endpoint for load balancing
 */
export interface ServiceEndpoint {
  url: string;
  weight: number;
  healthy: boolean;
  lastCheck?: Date;
  consecutiveFailures: number;
}

/**
 * Cache control configuration
 */
export interface CacheControlConfig {
  public?: boolean;
  private?: boolean;
  maxAge?: number;
  sMaxAge?: number;
  noCache?: boolean;
  noStore?: boolean;
  mustRevalidate?: boolean;
  immutable?: boolean;
}

/**
 * Request logging data
 */
export interface RequestLogData {
  method: string;
  url: string;
  ip?: string;
  userAgent?: string;
  userId?: string;
  tenantId?: string;
  correlationId?: string;
  duration?: number;
  statusCode?: number;
  errorMessage?: string;
}

/**
 * OPA policy input
 */
export interface OpaPolicyInput {
  user: {
    id: string;
    roles: string[];
    permissions?: string[];
    tenantId: string;
  };
  resource: {
    type: string;
    id?: string;
    action: string;
  };
  context: {
    ip?: string;
    method: string;
    path: string;
  };
}

/**
 * OPA policy result
 */
export interface OpaPolicyResult {
  allow: boolean;
  reasons?: string[];
}

/**
 * Health check result
 */
export interface HealthCheckResult {
  status: 'healthy' | 'unhealthy' | 'degraded';
  timestamp: string;
  version?: string;
  uptime?: number;
  checks: Record<string, {
    status: 'up' | 'down';
    latency?: number;
    message?: string;
  }>;
}

/**
 * Type guard to check if request has user
 */
export function isAuthenticated(req: Request): req is AuthenticatedRequest & { user: AuthenticatedUser } {
  return (req as AuthenticatedRequest).user !== undefined;
}

/**
 * Type guard to check if request has tenant context
 */
export function hasTenantContext(req: Request): req is AuthenticatedRequest & { tenantContext: TenantContext } {
  return (req as AuthenticatedRequest).tenantContext !== undefined;
}

/**
 * Get user from request with type safety
 */
export function getUserFromRequest(req: Request): AuthenticatedUser | undefined {
  return (req as AuthenticatedRequest).user;
}

/**
 * Get tenant ID from request with type safety
 */
export function getTenantIdFromRequest(req: Request): string | undefined {
  const authReq = req as AuthenticatedRequest;
  return authReq.tenantId ?? authReq.user?.tenantId;
}

/**
 * Get tenant context from request with type safety
 */
export function getTenantContext(req: Request): TenantContext | undefined {
  return (req as AuthenticatedRequest).tenantContext;
}
