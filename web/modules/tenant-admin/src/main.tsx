import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ConfiguredBrowserRouter } from '@aquaculture/shared-ui';
import TenantAdminModule from './Module';
import './styles.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5 * 60 * 1000, // 5 minutes
      retry: 1,
    },
  },
});

/**
 * Standalone entry point for tenant-admin module
 * Used for development and standalone mode
 */
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <ConfiguredBrowserRouter>
        <TenantAdminModule />
      </ConfiguredBrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>
);
