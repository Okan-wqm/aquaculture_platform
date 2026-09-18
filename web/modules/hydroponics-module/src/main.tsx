import React from 'react';
import ReactDOM from 'react-dom/client';
import { ConfirmProvider } from '@aquaculture/shared-ui';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import HydroponicsModule from './Module';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5 * 60 * 1000,
      retry: 1,
    },
  },
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <div className="min-h-screen bg-gray-50">
          <ConfirmProvider>
            <HydroponicsModule />
          </ConfirmProvider>
        </div>
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>
);
