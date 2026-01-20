/**
 * API Configuration
 *
 * Centralized API endpoint configuration for sensor module.
 */

// GraphQL API endpoint - uses environment variable with fallback
export const API_URL = import.meta.env.VITE_GRAPHQL_URL || 'http://localhost:3000/graphql';

// Helper to get auth headers
export function getAuthHeaders(): Record<string, string> {
  const token = localStorage.getItem('access_token');
  const tenantId = localStorage.getItem('tenant_id');

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
    headers: getAuthHeaders(),
    body: JSON.stringify({ query, variables }),
  });

  const result = await response.json();

  if (result.errors) {
    throw new Error(result.errors[0]?.message || 'GraphQL Error');
  }

  return result.data;
}
