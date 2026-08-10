import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { registerSW } from 'virtual:pwa-register';

import { App } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { IdentityBoundary } from './components/IdentityBoundary';
import { AuthProvider } from './hooks/useAuth';
import { OfflineProvider } from './hooks/useOfflineQueue';
import { I18nProvider } from './i18n';
import './styles/main.css';
import { logger } from './utils/logger';

/**
 * FE-HIGH-056: typed guard for the react-query retry predicate. The thrown error
 * is `unknown`; an HTTP/GraphQL failure may carry a numeric `status`. Narrow it
 * structurally (no unsafe cast) so a 401/403 short-circuits retry while any other
 * error shape falls through to the count-based policy.
 */
function getErrorStatus(error: unknown): number | undefined {
  if (typeof error === 'object' && error !== null && 'status' in error) {
    const { status } = error;
    return typeof status === 'number' ? status : undefined;
  }
  return undefined;
}

// Create query client with offline-friendly defaults
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60 * 5, // 5 minutes
      gcTime: 1000 * 60 * 60 * 24, // 24 hours (formerly cacheTime)
      retry: (failureCount, error) => {
        // Don't retry on auth errors
        const status = getErrorStatus(error);
        if (status === 401 || status === 403) {
          return false;
        }
        return failureCount < 3;
      },
      networkMode: 'offlineFirst',
    },
    mutations: {
      networkMode: 'offlineFirst',
    },
  },
});

// Register service worker.
// `const updateSW = registerSW(...)` returns an update trigger the onNeedRefresh
// callback re-invokes; the registerSW() call itself does not return a promise, so
// it is a plain assignment (no floating-promise concern).
const updateSW = registerSW({
  onNeedRefresh() {
    if (confirm('New version available. Reload to update?')) {
      // FE-HIGH-056: updateSW(true) returns a Promise; `void` marks it
      // intentionally un-awaited (we trigger the reload-on-activate and let the
      // SW take over) instead of leaving a floating promise.
      void updateSW(true);
    }
  },
  onOfflineReady() {
    logger.info('App ready to work offline');
  },
  onRegistered(r) {
    logger.info('Service worker registered:', r);
  },
  onRegisterError(error) {
    logger.error('Service worker registration error:', error);
  },
});

// FE-HIGH-056: explicit null check for the mount node instead of a forbidden
// non-null assertion. A missing #root is a deploy-shell error, not a runtime
// condition to hide — throw a clear message so it surfaces immediately.
const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('AquaMobil mount failed: #root element not found in document.');
}

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      {/* FE-HIGH-053: ROOT ErrorBoundary — the outermost recoverable boundary.
          Placed INSIDE QueryClientProvider (so a Try-Again reload still has a
          client) but OUTSIDE BrowserRouter / AuthProvider so a crash in any
          provider, the router, or a layout falls back to the recoverable card
          instead of white-screening the entire PWA. The route-level boundary in
          App.tsx and the 4 hub-page boundaries compose UNDER this one for finer
          granularity. */}
      <ErrorBoundary>
        {/* P-28: mobil i18n — dil tarayıcıdan sezilir (varsayılan tr).
            Router/Auth ÜSTÜNDE: hata kartları dahil her yüzey t() erişir. */}
        <I18nProvider>
          <BrowserRouter basename="/mobile">
            <AuthProvider>
              <IdentityBoundary>
                <OfflineProvider>
                  <App />
                </OfflineProvider>
              </IdentityBoundary>
            </AuthProvider>
          </BrowserRouter>
        </I18nProvider>
      </ErrorBoundary>
    </QueryClientProvider>
  </React.StrictMode>,
);
