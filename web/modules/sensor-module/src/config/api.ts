/**
 * API Configuration — Sensor Module
 *
 * WHY THIS IS A THIN DELEGATE, NOT A SEPARATE CLIENT:
 * Every MFE module MUST use the shared graphqlClient from @aquaculture/shared-ui.
 * The shared client provides: token lifecycle barrier (prevents 401 race on page
 * load), automatic 401 → token refresh → retry, session clear on permanent auth
 * failure, and Module Federation cross-bundle token propagation.
 *
 * Previously, this file had its own raw `fetch()` wrapper that bypassed all of
 * these mechanisms, causing 401 Unauthorized on every page load because requests
 * fired before silentRefresh() restored the token from the httpOnly cookie.
 *
 * The import path `import { graphqlFetch } from '../config/api'` is preserved
 * so existing hooks don't need to change their imports.
 */

import { graphqlClient, getAccessToken, getTenantId } from '@aquaculture/shared-ui';

// GraphQL API endpoint — used by the shared client under the hood.
// Safety guard: if a localhost URL was embedded at build-time but we're running
// on a remote host, fall back to relative '/graphql' to avoid CSP violations.
const envUrl = import.meta.env.VITE_GRAPHQL_URL || import.meta.env.VITE_API_URL;
const isRemoteWithLocalUrl = envUrl?.includes('localhost') &&
  typeof window !== 'undefined' && window.location.hostname !== 'localhost';
export const API_URL = (!envUrl || isRemoteWithLocalUrl) ? '/graphql' : envUrl;

/**
 * Auth headers — kept for non-GraphQL REST calls (e.g., file uploads).
 */
export function getAuthHeaders(): Record<string, string> {
  const token = getAccessToken();
  const tenantId = getTenantId();

  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(tenantId ? { 'X-Tenant-Id': tenantId } : {}),
  };
}

/**
 * GraphQL fetch — delegates to the shared graphqlClient.
 *
 * The shared client handles: lifecycle barrier, 401 retry with token refresh,
 * session clear on permanent failure, and tenant header propagation.
 *
 * @returns The `data` field from the GraphQL response (unwrapped).
 */
export async function graphqlFetch<T>(
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  return graphqlClient.request<T>(query, variables);
}
