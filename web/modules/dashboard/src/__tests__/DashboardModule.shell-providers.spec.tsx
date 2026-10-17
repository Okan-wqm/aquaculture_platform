/**
 * The dashboard remote renders under the shell's provider tree (FE-HIGH-343).
 *
 * Production once showed "Failed to Load Dashboard" because the remote read a
 * shared-ui context the shell's providers did not reach (each bundle had its
 * own shared-ui; federation-shared-ui.spec.ts proves both configs now share
 * one). This spec mounts `./Module` the way the shell does — the
 * `/dashboard/*` route inside I18nProvider, QueryClientProvider, a router,
 * TenantProvider, ToastProvider and ConfirmProvider, with the real shared-ui
 * providers — and opens each module dashboard. Two collaborators are
 * stubbed: the session (AuthProvider's bootstrap is a token refresh plus a
 * `me` request) and the gateway (fakeGateway).
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import {
  ConfirmProvider,
  I18nProvider,
  TenantProvider,
  ToastProvider,
} from '@aquaculture/shared-ui';

import DashboardModule from '../Module';

import { fakeGateway } from './fakeGateway';

const gateway = vi.hoisted(() => ({
  current: null as null | ReturnType<typeof import('./fakeGateway').fakeGateway>,
}));

const AUTH = {
  token: 'tok',
  tenantId: 'tenant-1',
  isTenantAdmin: false,
  hasPermission: (): boolean => false,
};

const SESSION = {
  user: { id: 'u1', firstName: 'Ayse', role: 'MODULE_MANAGER', tenantId: 'tenant-1' },
  isAuthenticated: true,
  isLoading: false,
  isSuperAdmin: (): boolean => false,
  hasRoleOrHigher: (): boolean => false,
  hasModuleAccess: (): boolean => true,
};

vi.mock('../../../../shared-ui/src/hooks/useAuth', () => ({ useAuth: () => AUTH }));

// The route guards (RequireAuth, RequireRole) read the context module directly.
vi.mock('../../../../shared-ui/src/contexts/AuthContext', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../shared-ui/src/contexts/AuthContext')>()),
  useAuthContext: () => SESSION,
}));

vi.mock('@aquaculture/shared-ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aquaculture/shared-ui')>();
  return {
    ...actual,
    useAuth: () => AUTH,
    useAuthContext: () => SESSION,
    graphqlClient: {
      request: (document: string, variables?: Record<string, unknown>) =>
        gateway.current!.request(document, variables),
    },
  };
});

/** What a route-level boundary in the shell would show: the thrown message. */
class CaptureBoundary extends React.Component<
  { children: React.ReactNode },
  { message: string | null }
> {
  state = { message: null as string | null };

  static getDerivedStateFromError(error: Error): { message: string } {
    return { message: error.message };
  }

  render(): React.ReactNode {
    return this.state.message === null ? (
      this.props.children
    ) : (
      <p data-testid="remote-load-error">{this.state.message}</p>
    );
  }
}

/** web/shell/src/bootstrap.tsx's tree, AuthProvider aside (stubbed above). */
function renderInShell(path: string): void {
  render(
    <I18nProvider locale="tr">
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter initialEntries={[path]}>
          <TenantProvider>
            <ToastProvider>
              <ConfirmProvider>
                <CaptureBoundary>
                  <Routes>
                    <Route path="/dashboard/*" element={<DashboardModule />} />
                  </Routes>
                </CaptureBoundary>
              </ConfirmProvider>
            </ToastProvider>
          </TenantProvider>
        </MemoryRouter>
      </QueryClientProvider>
    </I18nProvider>,
  );
}

beforeEach(() => {
  gateway.current = fakeGateway();
});

describe('dashboard remote under the shell provider tree', () => {
  it.each([
    ['/dashboard', 'Üretim'],
    ['/dashboard/control', 'Kontrol ve sensörler'],
    ['/dashboard/greenhouse', 'Sera'],
  ])('renders %s with nothing beyond the providers the shell mounts', async (path, title) => {
    renderInShell(path);

    expect(screen.queryByTestId('remote-load-error')).toBeNull();
    expect(await screen.findByRole('heading', { name: title })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Saha durumu' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Aktif alarmlar' })).toBeInTheDocument();
  });
});
