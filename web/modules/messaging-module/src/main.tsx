import { ConfiguredBrowserRouter } from '@aquaculture/shared-ui';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import ReactDOM from 'react-dom/client';

import MessagingModule from './Module';
import './styles.css';

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 60 * 1000, retry: 1 } },
});

// Standalone dev entry — in production the shell renders <MessagingModule/>.
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <ConfiguredBrowserRouter>
        <MessagingModule />
      </ConfiguredBrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
);
