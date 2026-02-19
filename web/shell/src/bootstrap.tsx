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
import { installRemoteIntegrityGuard } from './utils/remoteIntegrity';
import App from './App';
import './styles/index.css';

// SH-SEC-04: Install the remote module integrity guard before any lazy imports
// execute. This patches document.createElement to intercept dynamically injected
// <script> elements and validate their origin against the allowlist.
installRemoteIntegrityGuard();

// ============================================================================
// Query Client Configuration
// ============================================================================

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // 5 minutes stale time
      staleTime: 5 * 60 * 1000,
      // 30 minutes cache time
      gcTime: 30 * 60 * 1000,
      // 3 retries on error
      retry: 3,
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
