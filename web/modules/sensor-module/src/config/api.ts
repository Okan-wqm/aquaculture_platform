/**
 * API Configuration
 *
 * Centralized API endpoint configuration for sensor module.
 */

import { getAccessToken, getTenantId } from '@aquaculture/shared-ui';

// GraphQL API endpoint - uses environment variable with fallback
// Safety guard: if a localhost URL was embedded at build-time but we're running
// on a remote host, fall back to relative '/graphql' to avoid CSP violations.
const envUrl = import.meta.env.VITE_GRAPHQL_URL || import.meta.env.VITE_API_URL;
const isRemoteWithLocalUrl = envUrl?.includes('localhost') &&
  typeof window !== 'undefined' && window.location.hostname !== 'localhost';
export const API_URL = (!envUrl || isRemoteWithLocalUrl) ? '/graphql' : envUrl;

// Helper to get auth headers
export function getAuthHeaders(): Record<string, string> {
  const token = getAccessToken();
  const tenantId = getTenantId();

  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(tenantId ? { 'X-Tenant-Id': tenantId } : {}),
  };
}

// Generic GraphQL fetch helper
export async function graphqlFetch<T>(
  query: string,
  variables?: Record<string, unknown>
): Promise<T> {
  const response = await fetch(API_URL, {
    method: 'POST',
    credentials: 'include',
    headers: getAuthHeaders(),
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  const result = await response.json();

  if (result.errors) {
    throw new Error(result.errors[0]?.message || 'GraphQL Error');
  }

  return result.data;
}
