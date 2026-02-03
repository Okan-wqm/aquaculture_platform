import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import { App as KonstaApp } from 'konsta/react';
import { App } from './App';
import { AuthProvider } from './hooks/useAuth';
import { OfflineProvider } from './hooks/useOfflineQueue';
import { registerSW } from 'virtual:pwa-register';
import './styles/main.css';

// Create query client with offline-friendly defaults
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60 * 5, // 5 minutes
      gcTime: 1000 * 60 * 60 * 24, // 24 hours (formerly cacheTime)
      retry: (failureCount, error) => {
        // Don't retry on auth errors
        if ((error as any)?.status === 401 || (error as any)?.status === 403) {
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

// Register service worker
const updateSW = registerSW({
  onNeedRefresh() {
    if (confirm('New version available. Reload to update?')) {
      updateSW(true);
    }
  },
  onOfflineReady() {
    console.log('App ready to work offline');
  },
  onRegistered(r) {
    console.log('Service worker registered:', r);
  },
  onRegisterError(error) {
    console.error('Service worker registration error:', error);
  },
});

// Detect iOS for Konsta theme
const isIOS =
  typeof navigator !== 'undefined' &&
  (/iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1));

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthProvider>
          <OfflineProvider>
            <KonstaApp theme={isIOS ? 'ios' : 'material'} safeAreas>
              <App />
            </KonstaApp>
          </OfflineProvider>
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>
);
