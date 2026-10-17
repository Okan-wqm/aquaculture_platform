/**
 * The three module dashboards end to end over a fake gateway: each route
 * renders its own site table from real records, the alarm panel of its
 * module, the inbox the viewer may read and — for a tenant admin only — the
 * recent activity. What has no backend renders only through MockPreview,
 * naming its finding. A source the viewer's role may not read is never
 * requested.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '@aquaculture/shared-ui';

import { fakeGateway, SITE_A, type RecordedRequest } from './fakeGateway';

interface Viewer {
  isTenantAdmin: boolean;
  permissions: string[];
  modules: string[];
}

const state = vi.hoisted(() => ({
  viewer: { isTenantAdmin: false, permissions: [] as string[], modules: ['farm', 'sensor'] },
  gateway: null as null | ReturnType<typeof import('./fakeGateway').fakeGateway>,
}));

function authOf(viewer: Viewer): Record<string, unknown> {
  return {
    token: 'tok',
    tenantId: 'tenant-1',
    isTenantAdmin: viewer.isTenantAdmin,
    hasPermission: (permission: string): boolean =>
      viewer.isTenantAdmin || viewer.permissions.includes(permission),
  };
}

vi.mock('../../../../shared-ui/src/hooks/useAuth', () => ({
  useAuth: () => authOf(state.viewer),
}));

vi.mock('@aquaculture/shared-ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aquaculture/shared-ui')>();
  return {
    ...actual,
    useAuth: () => authOf(state.viewer),
    useAuthContext: () => ({
      isAuthenticated: true,
      isLoading: false,
      user: { id: 'u-9', role: state.viewer.isTenantAdmin ? 'TENANT_ADMIN' : 'MODULE_USER' },
      hasModuleAccess: (code: string) => state.viewer.modules.includes(code),
    }),
    graphqlClient: {
      request: (document: string, variables?: Record<string, unknown>) =>
        state.gateway!.request(document, variables),
    },
  };
});

import DashboardModule from '../Module';

function renderAt(path: string): void {
  render(
    <I18nProvider locale="en">
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/dashboard/*" element={<DashboardModule />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    </I18nProvider>,
  );
}

function operations(): string[] {
  return state.gateway!.requests.map((request: RecordedRequest) => request.operation);
}

beforeEach(() => {
  state.viewer = { isTenantAdmin: false, permissions: [], modules: ['farm', 'sensor'] };
  state.gateway = fakeGateway();
});

describe('Production dashboard (/dashboard)', () => {
  it('draws each fish site from its records: alarms, lowest oxygen against the limit, temperature, feed', async () => {
    renderAt('/dashboard');

    const link = await screen.findByRole('link', { name: 'Ayvalık Grow-out' });
    expect(link).toHaveAttribute('href', `/sites/environment/${SITE_A}`);
    const row = link.closest('tr');
    expect(row).not.toBeNull();
    const cells = within(row!);

    // The latest per unit counts: B-12's older 3.0 is superseded by its 5.8.
    const oxygen = await cells.findByText('DO min · 5.8 mg/L');
    expect(oxygen.className).toContain('text-sd-danger-ink');
    expect(cells.getByText('B-12 · limit ≥ 6.5')).toBeInTheDocument();
    expect(await cells.findByText('22.1 °C')).toBeInTheDocument();
    expect(cells.getByText('hottest B-03 · 24.6 °C')).toBeInTheDocument();
    // (600 + 540 + 100) + 860 = 2100 kg of 3400 kg planned.
    expect(await cells.findByText('62%')).toBeInTheDocument();
    expect(cells.getByText('2.1 / 3.4 t')).toBeInTheDocument();
    expect(cells.getByText('1 critical (P1) alarm')).toBeInTheDocument();
    expect(cells.getByTitle('Tank count as entered on the site’s systems')).toHaveTextContent(
      '18 tanks',
    );
    // The P1 alarm marks the row.
    expect(row!.className).toContain('var(--color-sd-hz-red)');
  });

  it('says plainly what a quiet site lacks instead of inventing a value', async () => {
    renderAt('/dashboard');
    const row = (await screen.findByRole('link', { name: 'Bodrum Hatchery' })).closest('tr')!;
    const cells = within(row);
    expect(await cells.findByText('no measurement in 24 h')).toBeInTheDocument();
    expect(await cells.findByText('no plan today')).toBeInTheDocument();
    expect(cells.getByText('None')).toBeInTheDocument();
    expect(row.className).not.toContain('var(--color-sd-hz');
  });

  it("lists the farm module's alarms, unacknowledged first, and acknowledges one", async () => {
    renderAt('/dashboard');
    const panel = screen
      .getByRole('heading', { name: 'Active alarms' })
      .closest('section') as HTMLElement;
    const items = await within(panel).findAllByRole('listitem');
    expect(items.map((item) => item.textContent)).toEqual([
      expect.stringContaining('Dissolved oxygen 4.1 mg/L in B-12'),
      expect.stringContaining('Water temperature back in range'),
      expect.stringContaining('Meal at 08:00 not fed'),
    ]);
    expect(within(items[0]!).getByText('UNACK')).toBeInTheDocument();
    expect(within(items[1]!).getByText('CLEARED')).toBeInTheDocument();
    expect(within(items[2]!).getByText('ACKED')).toBeInTheDocument();
    expect(within(panel).getByRole('link', { name: 'All alarms' })).toHaveAttribute(
      'href',
      '/sensor/alerts',
    );
    const alarmRequest = state.gateway!.requests.find(
      (request: RecordedRequest) => request.operation === 'DashboardModuleAlarms',
    );
    expect(alarmRequest?.variables?.['module']).toBe('FARM');

    await userEvent.click(within(items[0]!).getByRole('button', { name: 'Acknowledge DO low' }));
    await waitFor(() =>
      expect(
        state.gateway!.requests.find(
          (request: RecordedRequest) => request.operation === 'DashboardAcknowledgeAlert',
        )?.variables,
      ).toEqual({ input: { alertId: 'alarm-1' } }),
    );
  });

  it('asks a module user for nothing their role may not read: no seats, users, announcements or audit', async () => {
    renderAt('/dashboard');
    await screen.findByRole('link', { name: 'Ayvalık Grow-out' });
    expect(await screen.findByText('Nothing is waiting for you.')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Recent activity' })).toBeNull();
    for (const forbidden of [
      'DashboardSeats',
      'DashboardUsersMfa',
      'DashboardMaintenance',
      'DashboardRecentAudit',
    ]) {
      expect(operations()).not.toContain(forbidden);
    }
  });

  it('gives a tenant admin the seat, two-factor and maintenance notices and the recent activity', async () => {
    state.viewer = { isTenantAdmin: true, permissions: [], modules: ['farm', 'sensor'] };
    renderAt('/dashboard');
    expect(await screen.findByText('Seat limit almost reached')).toBeInTheDocument();
    expect(
      await screen.findByText('2 privileged users without two-factor sign-in'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Ingrid Nilsen, Lars Berg can approve changes without two-factor sign-in.'),
    ).toBeInTheDocument();
    expect(
      await screen.findByText('Platform maintenance: 18 Oct, 02:00–04:00 UTC'),
    ).toBeInTheDocument();
    expect(await screen.findByText('ROLE_CHANGED · User')).toBeInTheDocument();
    // The access-request item has no backend: a labelled preview naming its finding.
    expect(document.querySelector('[data-preview-finding="RBAC-MEDIUM-020"]')).not.toBeNull();
  });

  it('hides the alarm list link from a tenant without the sensor module', async () => {
    state.viewer = { isTenantAdmin: false, permissions: [], modules: ['farm'] };
    renderAt('/dashboard');
    await screen.findByText('Dissolved oxygen 4.1 mg/L in B-12');
    expect(screen.queryByRole('link', { name: 'All alarms' })).toBeNull();
  });

  it('shows a failed site list as a failure, not as an empty tenant', async () => {
    state.gateway = fakeGateway({
      DashboardActiveSites: () => {
        throw new Error('farm-service down');
      },
    });
    renderAt('/dashboard');
    expect(await screen.findByText('Site status could not be loaded.')).toBeInTheDocument();
  });
});

describe('Control & sensors dashboard (/dashboard/control)', () => {
  it('draws gateways, sensors and PLCs per site, and the sensor module’s alarms', async () => {
    renderAt('/dashboard/control');
    const row = (await screen.findByRole('link', { name: 'Ayvalık Grow-out' })).closest('tr')!;
    const cells = within(row);
    expect(await cells.findByText('1 / 2 online')).toBeInTheDocument();
    expect(await cells.findByText('12 sensors')).toBeInTheDocument();
    expect(await cells.findByText('1 / 1 connected')).toBeInTheDocument();
    expect(await cells.findByText('1 PLC alarm')).toBeInTheDocument();
    expect(cells.getByRole('link', { name: 'Ayvalık Grow-out' })).toHaveAttribute(
      'href',
      '/sensor/devices',
    );
    await waitFor(() => expect(operations()).toContain('DashboardModuleAlarms'));
    const modules = state
      .gateway!.requests.filter(
        (request: RecordedRequest) => request.operation !== 'DashboardSiteGateways',
      )
      .map((request: RecordedRequest) => request.variables?.['module'])
      .filter((module: unknown) => module !== undefined);
    expect(new Set(modules)).toEqual(new Set(['SENSOR']));
  });
});

describe('Greenhouse dashboard (/dashboard/greenhouse)', () => {
  it('renders its zone table only as a labelled preview and lists the hydroponics alarms', async () => {
    renderAt('/dashboard/greenhouse');
    const preview = document.querySelector('[data-preview-finding="PRODUCT-MEDIUM-001"]');
    expect(preview).not.toBeNull();
    expect(within(preview as HTMLElement).getByText('Söke · Zone 2')).toBeInTheDocument();
    await waitFor(() => expect(operations()).toContain('DashboardModuleAlarms'));
    const alarmRequest = state.gateway!.requests.find(
      (request: RecordedRequest) => request.operation === 'DashboardModuleAlarms',
    );
    expect(alarmRequest?.variables?.['module']).toBe('HYDROPONICS');
    // No farm or sensor site rows are fetched for the greenhouse table.
    expect(operations()).not.toContain('DashboardSiteMeasurements');
  });
});
