/**
 * The dashboard remote renders under the shell's provider tree (FE-HIGH-343).
 *
 * Production showed "Failed to Load Dashboard" with "useTenantContext must be
 * used within a TenantProvider" although the shell mounts TenantProvider
 * (web/shell/src/bootstrap.tsx). The remote must own no provider of its own:
 * the TenantContext it reads is the host's. This spec mounts `./Module` the way
 * the shell does — the `/dashboard/*` route inside I18nProvider,
 * QueryClientProvider, a router, TenantProvider, ToastProvider and
 * ConfirmProvider — with the real shared-ui providers.
 *
 * Two collaborators are stubbed: the session (AuthProvider's bootstrap is a
 * token refresh plus a `me` request) — the signed-in user and the guard
 * family's RequireAuth that admits them — and the dashboard's GraphQL hooks.
 *
 * Under vitest the shell's providers and the remote's hooks resolve to one
 * shared-ui module by construction. In a browser that needs the federation
 * share scope; federation-shared-ui.spec.ts proves both configs reach it.
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import {
  ConfirmProvider,
  I18nProvider,
  TenantProvider,
  ToastProvider,
  type Tenant,
} from '@aquaculture/shared-ui';

import DashboardModule from '../Module';

// recharts' ResponsiveContainer measures its parent; jsdom has no ResizeObserver.
class NoopResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
vi.stubGlobal('ResizeObserver', NoopResizeObserver);

vi.mock('@aquaculture/shared-ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aquaculture/shared-ui')>();
  return {
    ...actual,
    useAuthContext: () => ({
      user: { id: 'u1', firstName: 'Ayse', role: 'MODULE_MANAGER', tenantId: 'tenant-1' },
      isAuthenticated: true,
      isLoading: false,
    }),
    // The module's session gate (FE-MEDIUM-349: the shared one, not a copy) reads the
    // session inside shared-ui; with the session stubbed it admits the signed-in user.
    RequireAuth: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  };
});

const query = <T,>(data: T) => ({
  data,
  isLoading: false,
  isError: false,
  error: null,
  refetch: vi.fn(),
});
const mutation = () => ({ mutateAsync: vi.fn() });

vi.mock('../hooks/useDashboardData', () => ({
  useDashboardStats: () =>
    query({
      totalFarms: 3,
      activeSensors: 12,
      alertsToday: 1,
      productionTons: 4,
      farmsTrend: 0,
      sensorsTrend: 0,
      alertsTrend: 0,
      productionTrend: 0,
      totalUsers: 9,
      activeUsers: 7,
    }),
  useAlertSummary: () => query({ alerts: [], summary: { total: 0 } }),
  useAcknowledgeAlert: () => mutation(),
  useResolveAlert: () => mutation(),
  useTaskStats: () =>
    query({
      totalToday: 0,
      completedToday: 0,
      overdueCount: 0,
      upcomingCount: 0,
      completionRate: 0,
    }),
  useTodaysTasks: () => query([]),
  useStorageOverview: () => query({ lowStockAlertCount: 0, lowStockAlerts: [] }),
  useCriticalWaterQuality: () => query([]),
  useRecentActivity: () => query([]),
}));

const ACME: Tenant = {
  id: 'tenant-1',
  name: 'Acme Fish',
  slug: 'acme-fish',
  tier: 'professional',
  status: 'active',
  settings: {
    timezone: 'Europe/Istanbul',
    locale: 'tr',
    currency: 'TRY',
    dateFormat: 'DD.MM.YYYY',
    measurementSystem: 'metric',
  },
  limits: {
    maxUsers: 10,
    maxFarms: 5,
    maxPonds: 50,
    maxSensors: 100,
    maxAlertRules: 20,
    dataRetentionDays: 365,
    apiRateLimit: 1000,
  },
  createdAt: new Date('2026-01-01T00:00:00Z'),
};

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

/** The shell's route for the remote: `/dashboard/*` → `dashboard/Module`. */
function DashboardRoute(): React.ReactElement {
  return (
    <Routes>
      <Route path="/dashboard/*" element={<DashboardModule />} />
    </Routes>
  );
}

/** web/shell/src/bootstrap.tsx's tree, AuthProvider aside (stubbed above). */
function renderInShell(initialTenant?: Tenant): void {
  render(
    <I18nProvider locale="tr">
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter initialEntries={['/dashboard']}>
          <TenantProvider initialTenant={initialTenant}>
            <ToastProvider>
              <ConfirmProvider>
                <CaptureBoundary>
                  <DashboardRoute />
                </CaptureBoundary>
              </ConfirmProvider>
            </ToastProvider>
          </TenantProvider>
        </MemoryRouter>
      </QueryClientProvider>
    </I18nProvider>,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('dashboard remote under the shell provider tree', () => {
  it('renders /dashboard with nothing beyond the providers the shell mounts', () => {
    renderInShell();

    expect(screen.queryByTestId('remote-load-error')).toBeNull();
    expect(screen.getByText(/Hos Geldiniz, Ayse/)).toBeInTheDocument();
    expect(screen.getByText('Toplam Ciftlik')).toBeInTheDocument();
  });

  it("reads the tenant from the host's TenantProvider", () => {
    renderInShell(ACME);

    expect(screen.getByText(/Acme Fish - Son guncelleme/)).toBeInTheDocument();
  });

  it('fails the way production did when the TenantContext it reads has no provider', () => {
    // React reports the caught render error on console.error; keep the run quiet.
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter initialEntries={['/dashboard']}>
          <CaptureBoundary>
            <DashboardRoute />
          </CaptureBoundary>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(screen.getByTestId('remote-load-error')).toHaveTextContent(
      'useTenantContext must be used within a TenantProvider',
    );
  });
});
