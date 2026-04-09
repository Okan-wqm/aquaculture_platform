/**
 * Shell Application - Bootstrap
 *
 * Actual application initialization lives here so that the Module Federation
 * runtime can negotiate shared singletons before any React code runs.
 * main.tsx does only `import('./bootstrap')` to trigger this asynchronously.
 */

import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider, TenantProvider, ConfiguredBrowserRouter } from '@aquaculture/shared-ui';
import App from './App';
import './styles/index.css';

// SECURITY: Remote integrity guard is installed in main.tsx (before this
// module loads) to ensure Document.prototype.createElement and
// Element.prototype.setAttribute patches are active before React/ReactDOM
// execute. See FE-CRITICAL-003.

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

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // 5 minutes stale time
      staleTime: 5 * 60 * 1000,
      // 30 minutes cache time
      gcTime: 30 * 60 * 1000,
      // Smart retry with exponential backoff (replaces blind `retry: 3`)
      retry: shouldRetryQuery,
      retryDelay: (attemptIndex: number) => Math.min(1000 * 2 ** attemptIndex, 30000),
      // Refetch on network reconnect
      refetchOnReconnect: true,
      refetchOnWindowFocus: false,
    },
    mutations: {
      retry: false,
    },
  },
});

// ============================================================================
// Render
// ============================================================================

const root = document.getElementById('root');

if (!root) {
  throw new Error('Root element not found');
}

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <ConfiguredBrowserRouter>
        <AuthProvider>
          <TenantProvider>
            <App />
          </TenantProvider>
        </AuthProvider>
      </ConfiguredBrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>
);
