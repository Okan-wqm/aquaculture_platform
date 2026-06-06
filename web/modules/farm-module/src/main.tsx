/**
 * Farm Module - Standalone Entry Point
 *
 * Bağımsız geliştirme için kullanılır.
 * Production'da Module Federation ile yüklenir.
 */

import React from 'react';
import ReactDOM from 'react-dom/client';
import { ConfiguredBrowserRouter } from '@aquaculture/shared-ui';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import FarmModule from './Module';
import './styles.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30 * 1000,
      retry: 1,
    },
  },
});

const root = document.getElementById('root');

if (root) {
  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <QueryClientProvider client={queryClient}>
        <ConfiguredBrowserRouter>
          <div className="min-h-screen bg-gray-50 p-6">
            <FarmModule />
          </div>
        </ConfiguredBrowserRouter>
      </QueryClientProvider>
    </React.StrictMode>
  );
}
