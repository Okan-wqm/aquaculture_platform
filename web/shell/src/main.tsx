/**
 * Shell Application - Entry Point
 *
 * Main entry point for the host application.
 * Configures React, Router, Query, and Context providers.
 */

import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider, TenantProvider, loadTokensFromStorage, ConfiguredBrowserRouter } from '@aquaculture/shared-ui';
import App from './App';
import './styles/index.css';

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
      // Refetch on window focus (optional)
      refetchOnWindowFocus: false,
    },
    mutations: {
      // No retry on mutation error
      retry: false,
    },
  },
});

// ============================================================================
// Startup Operations
// ============================================================================

// Load tokens from localStorage
loadTokensFromStorage();

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
