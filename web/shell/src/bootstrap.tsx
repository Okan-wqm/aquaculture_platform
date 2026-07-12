/**
 * Shell Application - Bootstrap
 *
 * Actual application initialization lives here so that the Module Federation
 * runtime can negotiate shared singletons before any React code runs.
 * main.tsx does only `import('./bootstrap')` to trigger this asynchronously.
 */

import { AuthProvider, TenantProvider, ConfiguredBrowserRouter, I18nProvider, ToastProvider, registerLogoutCleanup, refetchWhenBackendHealthy } from '@aquaculture/shared-ui';
import { installVisibilityTokenRefresh } from '@aquaculture/shared-ui';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import ReactDOM from 'react-dom/client';

import App from './App';
import { applyThemePreference, getStoredThemePreference } from './utils/theme';
import './styles/index.css';

// SECURITY: Remote integrity guard is installed in main.tsx (before this
// module loads) to ensure Document.prototype.createElement and
// Element.prototype.setAttribute patches are active before React/ReactDOM
// execute. See FE-CRITICAL-003.

// FE-HIGH-006: Install visibilitychange listener so returning to a sleeping
// tab triggers a proactive token refresh instead of a 401 force-logout.
installVisibilityTokenRefresh();
applyThemePreference(getStoredThemePreference());

// ============================================================================
// Query Client Configuration
// ============================================================================

/**
 * API retry strategy: max 3 retries with exponential backoff.
 * Prevents infinite retry loops that overload the server when
 * endpoints are consistently failing (e.g., database issues).
 *
 * 4xx errors are NOT retried -- they indicate client bugs or auth
 * issues that will not resolve by asking again. Only transient
 * failures (network errors, 502/503/504) are retried with backoff.
 * 500 errors are also excluded because they indicate server bugs,
 * not transient failures.
 */
const shouldRetryQuery = (failureCount: number, error: unknown): boolean => {
  if (failureCount >= 3) return false;

  // Extract HTTP status from the various error shapes in this codebase
  const status =
    (error as { status?: number })?.status ??
    (error as { statusCode?: number })?.statusCode ??
    (error as { code?: string })?.code;

  // GraphQL or REST client errors with an HTTP status
  if (typeof status === 'number') {
    // Client errors: never retry (auth issues, validation, not found)
    if (status >= 400 && status < 500) return false;
    // 500 Internal Server Error: server bug, retrying won't help
    if (status === 500) return false;
    // 502/503/504: transient infrastructure issues, retry with backoff
    return true;
  }

  // GraphQL client error codes that should not retry
  if (typeof status === 'string') {
    const noRetryGraphqlCodes = ['UNAUTHENTICATED', 'FORBIDDEN', 'BAD_USER_INPUT', 'GRAPHQL_ERROR'];
    if (noRetryGraphqlCodes.includes(status)) return false;
  }

  // Network errors (TypeError: Failed to fetch) -- retry
  if (error instanceof TypeError && error.message.includes('fetch')) return true;

  // Default: do not retry unknown errors
  return false;
};

/**
 * Per-domain staleTime strategy (FE-MEDIUM-026).
 *
 * A flat staleTime across all queries wastes bandwidth on real-time data
 * (sensors, batches) while under-caching reference data (species, config).
 * TanStack Query v5 does not support prefix-based staleTime natively, so we
 * use a `defaultOptions.queries.staleTime` callback that inspects the query
 * key and returns the appropriate value.
 *
 * Domain categories:
 *   REALTIME  (30s)  — sensor readings, batch status, tank occupancy, alarms
 *   STANDARD  (120s) — lists, dashboards, aggregations
 *   REFERENCE (600s) — species list, farm config, equipment types, i18n
 */
const REALTIME_PREFIXES = ['sensors', 'batches', 'tanks', 'alarms', 'feeding', 'mortalityRecords', 'batchOperations', 'harvestRecords'];
const REFERENCE_PREFIXES = ['species', 'config', 'equipmentTypes', 'farmConfig', 'i18n', 'permissions', 'roles', 'modules'];

function resolveStaleTime(query: { queryKey: readonly unknown[] }): number {
  // Walk the query key to find the first string segment after the tenant prefix.
  // Tenant-scoped keys look like ['tenant', tenantId, 'domain', ...].
  const segments = query.queryKey;
  const domainSegment = typeof segments[0] === 'string' && segments[0] === 'tenant'
    ? (typeof segments[2] === 'string' ? segments[2] : '')
    : (typeof segments[0] === 'string' ? segments[0] : '');

  if (REALTIME_PREFIXES.includes(domainSegment)) return 30_000;      // 30 seconds
  if (REFERENCE_PREFIXES.includes(domainSegment)) return 600_000;    // 10 minutes
  return 120_000;                                                     // 2 minutes default
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // FE-MEDIUM-026: Per-domain staleTime replaces flat 5min global
      staleTime: resolveStaleTime,
      // 30 minutes cache time
      gcTime: 30 * 60 * 1000,
      // Smart retry with exponential backoff (replaces blind `retry: 3`)
      retry: shouldRetryQuery,
      retryDelay: (attemptIndex: number) => Math.min(1000 * 2 ** attemptIndex, 30000),
      // FE-MEDIUM-025: Use TanStack Query built-in refetch instead of manual polling.
      // Gated by the backend-health breaker: during a detected gateway outage these
      // re-fire on every focus/reconnect and blank loaded data over a 502 — the
      // breaker suppresses them until a probe shows the backend is back.
      refetchOnReconnect: refetchWhenBackendHealthy,
      refetchOnWindowFocus: refetchWhenBackendHealthy,
    },
    mutations: {
      retry: false,
    },
  },
});

// FE tenant isolation: clear the in-memory TanStack Query cache on logout so a
// subsequent login (same browser, no full reload — the SPA logout path dispatches
// LOGOUT without navigating away) can never read the previous user's cached
// tenant data. logoutCleanup() invokes every registered callback; registering
// here (rather than calling useQueryClient() inside the shared AuthProvider)
// keeps shared-ui safe for consumers that mount AuthProvider without a
// QueryClientProvider (e.g. dashboard standalone). Pairs with the tenant-scoped
// query-key factory (defence in depth).
registerLogoutCleanup(() => queryClient.clear());

// ============================================================================
// Render
// ============================================================================

const root = document.getElementById('root');

if (!root) {
  throw new Error('Root element not found');
}

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <I18nProvider>
      <QueryClientProvider client={queryClient}>
        <ConfiguredBrowserRouter>
          <AuthProvider>
            <TenantProvider>
              {/* Single app-wide toast surface: via the federation singleton
                  React this context reaches every remote (admin, tenant,
                  farm), so useToast() renders here — no per-remote providers,
                  no duplicate aria-live regions. */}
              <ToastProvider>
                <App />
              </ToastProvider>
            </TenantProvider>
          </AuthProvider>
        </ConfiguredBrowserRouter>
      </QueryClientProvider>
    </I18nProvider>
  </React.StrictMode>
);
