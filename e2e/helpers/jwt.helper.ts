/**
 * JWT Helper for E2E Integration Tests
 *
 * Provides utilities for JWT token generation, parsing, and expiration
 * simulation for integration tests.
 */

import * as crypto from 'crypto';

/**
 * JWT payload structure matching the platform's token service.
 */
export interface JwtPayload {
  sub: string;
  email: string;
  role: string;
  roles: string[];
  tenantId: string | null;
  modules?: string[];
  resourcePermissions?: string[];
  jti?: string;
  iat?: number;
  exp?: number;
  aud?: string;
}

/**
 * Decode a JWT token without verification (for test assertions only).
 * DO NOT use this for authentication -- it skips signature verification.
 */
export function decodeJwt(token: string): JwtPayload {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new Error('Invalid JWT format');
  }
  const payloadPart = parts[1];
  if (!payloadPart) {
    throw new Error('Invalid JWT: missing payload');
  }
  const payload = Buffer.from(payloadPart, 'base64url').toString('utf-8');
  return JSON.parse(payload) as JwtPayload;
}

/**
 * Create a fake expired JWT for testing purposes.
 * Uses HS256 algorithm with a test secret -- the real auth service
 * must be running for valid token tests.
 *
 * SECURITY: This is for E2E tests ONLY. The token will be rejected
 * by the real auth service unless the secret matches.
 */
export function createExpiredJwt(
  payload: Partial<JwtPayload>,
  secret: string = 'test-secret-for-e2e-only',
): string {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);

  const fullPayload: JwtPayload = {
    sub: payload.sub || crypto.randomUUID(),
    email: payload.email || 'expired@test.com',
    role: payload.role || 'MODULE_USER',
    roles: payload.roles || [payload.role || 'MODULE_USER'],
    tenantId: payload.tenantId ?? null,
    jti: payload.jti || crypto.randomUUID(),
    iat: now - 7200, // 2 hours ago
    exp: now - 3600, // 1 hour ago (expired)
    aud: payload.aud || 'aquaculture-platform',
  };

  const encodedHeader = Buffer.from(JSON.stringify(header)).toString('base64url');
  const encodedPayload = Buffer.from(JSON.stringify(fullPayload)).toString('base64url');
  const signature = crypto
    .createHmac('sha256', secret)
    .update(`${encodedHeader}.${encodedPayload}`)
    .digest('base64url');

  return `${encodedHeader}.${encodedPayload}.${signature}`;
}

/**
 * Check if a JWT token is expired based on its exp claim.
 */
export function isTokenExpired(token: string): boolean {
  const payload = decodeJwt(token);
  if (!payload.exp) return false;
  return payload.exp < Math.floor(Date.now() / 1000);
}

/**
 * Extract the tenant ID from a JWT token.
 */
export function extractTenantId(token: string): string | null {
  const payload = decodeJwt(token);
  return payload.tenantId;
}

/**
 * Extract resource permissions from a JWT token.
 */
export function extractResourcePermissions(token: string): string[] {
  const payload = decodeJwt(token);
  return payload.resourcePermissions || [];
}

/**
 * Extract the user ID from a JWT token.
 */
export function extractUserId(token: string): string {
  const payload = decodeJwt(token);
  return payload.sub;
}
