/**
 * The three module dashboards end to end over a fake gateway: each route
 * renders its own site table from real records, the alarm panel of its
 * module, the inbox the viewer may read and — for a tenant admin only — the
 * recent activity. Each dashboard opens only for a viewer whose tenant holds
 * its module. What has no backend renders only through MockPreview, naming
 * its finding. A source the viewer's role may not read is never requested.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '@aquaculture/shared-ui';

import { fakeGateway, SITE_A, SITE_B, TANK_A1, TANK_A2, type RecordedRequest } from './fakeGateway';

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

function authContextOf(viewer: Viewer): Record<string, unknown> {
  return {
    isAuthenticated: true,
    isLoading: false,
    user: { id: 'u-9', role: viewer.isTenantAdmin ? 'TENANT_ADMIN' : 'MODULE_USER' },
    isSuperAdmin: () => false,
    hasRoleOrHigher: () => viewer.isTenantAdmin,
    hasModuleAccess: (code: string) => viewer.modules.includes(code),
  };
}

vi.mock('../../../../shared-ui/src/hooks/useAuth', () => ({
  useAuth: () => authOf(state.viewer),
}));

// The guard family (RequireAuth, RequireRole) reads the context module directly.
vi.mock('../../../../shared-ui/src/contexts/AuthContext', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../shared-ui/src/contexts/AuthContext')>()),
  useAuthContext: () => authContextOf(state.viewer),
}));

vi.mock('@aquaculture/shared-ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aquaculture/shared-ui')>();
  return {
    ...actual,
    useAuth: () => authOf(state.viewer),
    useAuthContext: () => authContextOf(state.viewer),
    graphqlClient: {
      request: (document: string, variables?: Record<string, unknown>) =>
        state.gateway!.request(document, variables),
    },
  };
});

import DashboardModule from '../Module';

let queryClient: QueryClient;

function renderAt(path: string): void {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <I18nProvider locale="en">
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/dashboard/*" element={<DashboardModule />} />
            <Route path="/unauthorized" element={<p>unauthorized page</p>} />
            <Route path="/" element={<p>landing page</p>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    </I18nProvider>,
  );
}

function operations(): string[] {
  return state.gateway!.requests.map((request: RecordedRequest) => request.operation);
}

function requestOf(operation: string): RecordedRequest | undefined {
  return state.gateway!.requests.find(
    (request: RecordedRequest) => request.operation === operation,
  );
}

async function siteRow(name: string): Promise<HTMLElement> {
  const row = (await screen.findByRole('link', { name })).closest('tr');
  if (row === null) throw new Error(`no row for ${name}`);
  return row;
}

function alarmPanel(): HTMLElement {
  const panel = screen.getByRole('heading', { name: 'Active alarms' }).closest('section');
  if (panel === null) throw new Error('no alarm panel');
  return panel;
}

beforeEach(() => {
  state.viewer = { isTenantAdmin: false, permissions: [], modules: ['farm', 'sensor'] };
  state.gateway = fakeGateway();
});

describe('Production dashboard (/dashboard)', () => {
  it('draws each fish site from its records: alarms, the lowest resolved oxygen, temperature, feed', async () => {
    renderAt('/dashboard');

    const link = await screen.findByRole('link', { name: 'Ayvalık Grow-out' });
    expect(link).toHaveAttribute('href', `/sites/environment/${SITE_A}`);
    const cells = within(await siteRow('Ayvalık Grow-out'));

    // B-12's live channel (5.8) is below B-03's manual sample (7.4) and the critical limit.
    const oxygen = await cells.findByText('DO min · 5.8 mg/L');
    expect(oxygen.className).toContain('text-sd-danger-ink');
    expect(cells.getByText('B-12 · limit ≥ 6.5')).toBeInTheDocument();
    expect(cells.getByText(/^live · /)).toBeInTheDocument();
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
    expect((await siteRow('Ayvalık Grow-out')).className).toContain('var(--color-sd-hz-red)');
  });

  it('reads oxygen through the reading resolver for the fed units — never the measurement list', async () => {
    renderAt('/dashboard');
    await within(await siteRow('Ayvalık Grow-out')).findByText('DO min · 5.8 mg/L');

    expect(requestOf('DashboardUnitOxygen')?.variables).toEqual({
      input: {
        parameterConfigId: 'pc-do',
        unitIds: [TANK_A1, TANK_A2].sort(),
        maxAgeSeconds: 86_400,
      },
    });
    expect(operations()).not.toContain('DashboardSiteMeasurements');
    // Bodrum feeds no unit today: there is nothing to ask the resolver about.
    const asked = state
      .gateway!.requests.filter((request) => request.operation === 'DashboardUnitOxygen')
      .map((request) => request.variables);
    expect(asked).toHaveLength(1);
  });

  it('says where a manual value came from, in the configured unit', async () => {
    state.gateway = fakeGateway({
      DashboardParameterLimits: () => ({
        parameterConfigs: [
          {
            id: 'pc-do',
            code: 'dissolved_oxygen',
            unit: 'ppm',
            warningMin: null,
            criticalMin: null,
          },
        ],
      }),
      DashboardUnitOxygen: () => ({
        resolvedUnitParameterValues: [
          {
            point: { id: TANK_A2 },
            value: 7.4,
            unit: 'ppm',
            sourceKind: 'MANUAL',
            observedAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
            unresolved: null,
          },
        ],
      }),
    });
    renderAt('/dashboard');
    const cells = within(await siteRow('Ayvalık Grow-out'));
    expect(await cells.findByText('DO min · 7.4 ppm')).toBeInTheDocument();
    expect(cells.getByText('B-03 · no limit configured')).toBeInTheDocument();
    expect(cells.getByText(/^manual entry · /)).toBeInTheDocument();
  });

  it('says plainly what a quiet site lacks instead of inventing a value', async () => {
    renderAt('/dashboard');
    const row = await siteRow('Bodrum Hatchery');
    const cells = within(row);
    expect(await cells.findByText('no unit is fed today')).toBeInTheDocument();
    expect(await cells.findByText('no plan today')).toBeInTheDocument();
    expect(cells.getByText('None')).toBeInTheDocument();
    expect(row.className).not.toContain('var(--color-sd-hz');
  });

  it('shows the temperature cell as failed, not loading, when the day plans fail', async () => {
    state.gateway = fakeGateway({
      DashboardSiteDayPlans: () => {
        throw new Error('farm-service down');
      },
    });
    renderAt('/dashboard');
    const row = await siteRow('Ayvalık Grow-out');
    await waitFor(() =>
      // Feed, oxygen and temperature all read the plans: each says it could not be loaded.
      expect(within(row).getAllByText('Could not be loaded')).toHaveLength(4),
    );
    expect(row.querySelector('.animate-pulse')).toBeNull();
  });

  it('marks the plan-so-far on the feed bar and turns it amber when feeding is behind', async () => {
    renderAt('/dashboard');
    const cells = within(await siteRow('Ayvalık Grow-out'));
    // 700 + 700 + 900 = 2300 of 3400 kg was due by now (68%); 62% was fed: within 10 points.
    expect(await cells.findByText('68% of the day’s plan was due by now')).toBeInTheDocument();
    const bar = (await siteRow('Ayvalık Grow-out')).querySelector('svg');
    expect(bar?.querySelector('line')).toHaveAttribute('x1', '68');
    expect(bar?.querySelector('.fill-sd-hz-amber')).toBeNull();
  });

  it('turns the feed bar amber when the fed share trails the plan-so-far by more than 10 points', async () => {
    const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
    state.gateway = fakeGateway({
      DashboardSiteDayPlans: (variables) => ({
        feedingDayPlans:
          variables?.['siteId'] === SITE_A
            ? [
                {
                  id: 'plan-1',
                  unitId: TANK_A1,
                  unitCode: 'B-12',
                  status: 'IN_PROGRESS',
                  plannedTotalKg: 1000,
                  unplannedActualKg: 0,
                  meals: [
                    { actualKg: 100, plannedKg: 600, scheduledAt: hourAgo, status: 'MISSED' },
                  ],
                },
              ]
            : [],
      }),
    });
    renderAt('/dashboard');
    const cells = within(await siteRow('Ayvalık Grow-out'));
    expect(
      await cells.findByText('Behind plan: 60% of the day’s plan was due by now'),
    ).toBeInTheDocument();
    expect((await siteRow('Ayvalık Grow-out')).querySelector('.fill-sd-hz-amber')).not.toBeNull();
  });

  it('greys a stale site’s readings', async () => {
    const hoursAgo = (hours: number): string =>
      new Date(Date.now() - hours * 3_600_000).toISOString();
    state.gateway = fakeGateway({
      DashboardSiteGateways: () => ({
        edgeDevices: { items: [{ id: 'gw', isOnline: false, lastSeenAt: hoursAgo(3) }], total: 1 },
      }),
      DashboardParameterLimits: () => ({
        parameterConfigs: [
          { id: 'pc-do', code: 'dissolved_oxygen', unit: 'mg/L', warningMin: 5, criticalMin: 4 },
        ],
      }),
      DashboardUnitOxygen: () => ({
        resolvedUnitParameterValues: [
          {
            point: { id: TANK_A1 },
            value: 7.9,
            unit: 'mg/L',
            sourceKind: 'MANUAL',
            observedAt: hoursAgo(2),
            unresolved: null,
          },
        ],
      }),
    });
    renderAt('/dashboard');
    const cells = within(await siteRow('Ayvalık Grow-out'));
    expect(await cells.findByText(/^Stale · /)).toBeInTheDocument();
    expect((await cells.findByText('DO min · 7.9 mg/L')).className).toContain(
      'text-sd-neutral-600',
    );
    expect((await cells.findByText('22.1 °C')).className).toContain('text-sd-neutral-600');
  });

  it('draws the site table as a static board: no search box, no sort buttons', async () => {
    renderAt('/dashboard');
    await siteRow('Ayvalık Grow-out');
    const table = screen.getByRole('table');
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(within(table).queryAllByRole('button')).toEqual([]);
    expect(
      screen.getByText(
        'Colour appears only when something is abnormal. Select a site’s name to open its live readings.',
      ),
    ).toBeInTheDocument();
  });

  it("lists the farm module's alarms, unacknowledged first, most severe pages asked for", async () => {
    renderAt('/dashboard');
    const items = await within(alarmPanel()).findAllByRole('listitem');
    expect(items.map((item) => item.textContent)).toEqual([
      expect.stringContaining('Dissolved oxygen 4.1 mg/L in B-12'),
      expect.stringContaining('Water temperature back in range'),
      expect.stringContaining('Meal at 08:00 not fed'),
    ]);
    expect(within(items[0]!).getByText('UNACK')).toBeInTheDocument();
    expect(within(items[1]!).getByText('CLEARED')).toBeInTheDocument();
    expect(within(items[2]!).getByText('ACKED')).toBeInTheDocument();
    expect(within(alarmPanel()).getByRole('link', { name: 'All alarms' })).toHaveAttribute(
      'href',
      '/sensor/alerts',
    );
    const alarmRequest = requestOf('DashboardModuleAlarms');
    expect(alarmRequest?.variables?.['module']).toBe('FARM');
  });

  it('names each alarm’s priority for assistive technology and keeps the unacknowledged stripe on a cleared one', async () => {
    renderAt('/dashboard');
    const items = await within(alarmPanel()).findAllByRole('listitem');
    expect(within(items[0]!).getByText('Critical')).toHaveClass('sr-only');
    expect(within(items[1]!).getByText('High')).toHaveClass('sr-only');
    expect(within(items[2]!).getByText('Medium')).toHaveClass('sr-only');
    // CLEARED is still unacknowledged: it keeps the priority stripe; ACKED has none.
    expect(items[1]!.className).toContain('var(--color-sd-hz-amber)');
    expect(items[2]!.className).not.toContain('var(--color-sd-hz');
  });

  it('opens the alarm list from a row and says where each alarm is, honestly', async () => {
    renderAt('/dashboard');
    const items = await within(alarmPanel()).findAllByRole('listitem');
    const rowLink = within(items[0]!).getByRole('link');
    expect(rowLink).toHaveAttribute('href', '/sensor/alerts');
    expect(within(items[0]!).getByText('DO low · Ayvalık Grow-out')).toBeInTheDocument();
    // alarm-3 records no site.
    expect(within(items[1]!).getByText('Temperature high · no site')).toBeInTheDocument();
  });

  it('says "a site outside your list" for an alarm at a site the viewer does not see', async () => {
    state.gateway = fakeGateway({
      DashboardModuleAlarms: () => ({
        open: [
          {
            id: 'alarm-x',
            ruleName: 'DO low',
            message: 'Dissolved oxygen 3.9 mg/L',
            severity: 'HIGH',
            acknowledged: false,
            resolved: false,
            triggeredAt: new Date().toISOString(),
            siteId: 'cccccccc-0000-4000-8000-00000000000c',
          },
        ],
        returned: [],
      }),
    });
    renderAt('/dashboard');
    expect(
      await within(alarmPanel()).findByText('DO low · a site outside your list'),
    ).toBeInTheDocument();
  });

  it('gives every acknowledge button a name of its own and refreshes the console’s alarm counts', async () => {
    state.gateway = fakeGateway({
      DashboardModuleAlarms: () => ({
        open: ['a', 'b'].map((id) => ({
          id: `alarm-${id}`,
          ruleName: 'DO low',
          message: `Dissolved oxygen low in ${id === 'a' ? 'B-12' : 'B-03'}`,
          severity: 'CRITICAL' as const,
          acknowledged: false,
          resolved: false,
          triggeredAt: new Date().toISOString(),
          siteId: SITE_A,
        })),
        returned: [],
      }),
    });
    renderAt('/dashboard');
    await within(alarmPanel()).findAllByRole('listitem');
    const buttons = within(alarmPanel()).getAllByRole('button', { name: /^Acknowledge / });
    const names = buttons.map((button) => button.getAttribute('aria-label'));
    expect(new Set(names).size).toBe(names.length);
    const b12 = within(alarmPanel()).getByRole('button', {
      name: /^Acknowledge Dissolved oxygen low in B-12 \(DO low, Ayvalık Grow-out, \d\d:\d\d\)$/,
    });

    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    await userEvent.click(b12);
    await waitFor(() =>
      expect(requestOf('DashboardAcknowledgeAlert')?.variables).toEqual({
        input: { alertId: 'alarm-a' },
      }),
    );
    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({
        queryKey: ['tenant', 'tenant-1', 'console', 'activeAlertCounts'],
      }),
    );
  });

  it('asks a module user for nothing their role may not read: no seats, users, announcements or audit', async () => {
    renderAt('/dashboard');
    await screen.findByRole('link', { name: 'Ayvalık Grow-out' });
    expect(await screen.findByText('Nothing is waiting for you.')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Recent activity' })).toBeNull();
    for (const forbidden of [
      'DashboardSeats',
      'DashboardUsers',
      'DashboardMaintenance',
      'DashboardRecentAudit',
    ]) {
      expect(operations()).not.toContain(forbidden);
    }
  });

  it('gives a users:view delegate the two-factor notice and nothing of the tenant admin’s', async () => {
    state.viewer = { isTenantAdmin: false, permissions: ['users:view'], modules: ['farm'] };
    renderAt('/dashboard');
    expect(
      await screen.findByText('2 privileged users without two-factor sign-in'),
    ).toBeInTheDocument();
    expect(operations()).toContain('DashboardUsers');
    for (const forbidden of ['DashboardSeats', 'DashboardMaintenance', 'DashboardRecentAudit']) {
      expect(operations()).not.toContain(forbidden);
    }
    expect(screen.queryByText('Seat limit almost reached')).toBeNull();
    expect(document.querySelector('[data-preview-finding="RBAC-MEDIUM-020"]')).toBeNull();
  });

  it('gives a roles:view delegate the access-request preview and requests nothing for it', async () => {
    state.viewer = { isTenantAdmin: false, permissions: ['roles:view'], modules: ['farm'] };
    renderAt('/dashboard');
    await screen.findByRole('link', { name: 'Ayvalık Grow-out' });
    expect(document.querySelector('[data-preview-finding="RBAC-MEDIUM-020"]')).not.toBeNull();
    for (const forbidden of [
      'DashboardSeats',
      'DashboardUsers',
      'DashboardMaintenance',
      'DashboardRecentAudit',
    ]) {
      expect(operations()).not.toContain(forbidden);
    }
  });

  it('gives a tenant admin the seat, two-factor and maintenance notices and the recent activity in words', async () => {
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
    const activity = screen.getByRole('heading', { name: 'Recent activity' }).closest('section')!;
    await waitFor(() =>
      expect(
        within(activity)
          .getAllByRole('listitem')
          .map((entry) => entry.textContent),
      ).toEqual([
        expect.stringContaining('Ingrid Nilsen changed a user’s role'),
        expect.stringContaining('Someone outside your users signed in'),
        expect.stringContaining('Lars Berg recorded BACKUP_EXPORTED'),
      ]),
    );
    expect(activity.textContent).not.toContain('f0f0f0f0');
    // The access-request item has no backend: a labelled preview naming its finding.
    expect(document.querySelector('[data-preview-finding="RBAC-MEDIUM-020"]')).not.toBeNull();
  });

  it('hides the alarm list links from a tenant without the sensor module', async () => {
    state.viewer = { isTenantAdmin: false, permissions: [], modules: ['farm'] };
    renderAt('/dashboard');
    const items = await within(alarmPanel()).findAllByRole('listitem');
    expect(within(alarmPanel()).queryByRole('link', { name: 'All alarms' })).toBeNull();
    expect(within(items[0]!).queryByRole('link')).toBeNull();
  });

  it('shows a failed site list as a failure, not as an empty tenant', async () => {
    state.gateway = fakeGateway({
      DashboardActiveSites: () => {
        throw new Error('farm-service down');
      },
    });
    renderAt('/dashboard');
    expect(await screen.findByText('Site status could not be loaded.')).toBeInTheDocument();
    // Without the site list no site can be named — and none is called "outside your list".
    expect(
      await within(alarmPanel()).findByText('DO low · site name unavailable'),
    ).toBeInTheDocument();
  });
});

describe('module gates', () => {
  it('opens each dashboard only to a tenant holding its module', async () => {
    state.viewer = { isTenantAdmin: false, permissions: [], modules: ['sensor'] };
    renderAt('/dashboard');
    expect(await screen.findByText('unauthorized page')).toBeInTheDocument();
    expect(operations()).not.toContain('DashboardSiteDayPlans');
  });

  it('opens Control & sensors to a sensor tenant', async () => {
    state.viewer = { isTenantAdmin: false, permissions: [], modules: ['sensor'] };
    renderAt('/dashboard/control');
    expect(await screen.findByRole('link', { name: 'Ayvalık Grow-out' })).toBeInTheDocument();
  });

  it('keeps Greenhouse from a tenant without hydroponics', async () => {
    renderAt('/dashboard/greenhouse');
    expect(await screen.findByText('unauthorized page')).toBeInTheDocument();
  });

  it('sends an unknown dashboard path to the landing, which picks the member’s workspace', async () => {
    renderAt('/dashboard/nowhere');
    expect(await screen.findByText('landing page')).toBeInTheDocument();
  });
});

describe('Control & sensors dashboard (/dashboard/control)', () => {
  it('draws gateways, sensors and PLCs per site, and the sensor module’s alarms', async () => {
    renderAt('/dashboard/control');
    const cells = within(await siteRow('Ayvalık Grow-out'));
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
    expect(within(await siteRow('Bodrum Hatchery')).getByText('No gateway')).toBeInTheDocument();
    expect(SITE_B).not.toBe(SITE_A);
  });
});

describe('Greenhouse dashboard (/dashboard/greenhouse)', () => {
  it('renders its zone table only as a labelled preview and lists the hydroponics alarms', async () => {
    state.viewer = { isTenantAdmin: false, permissions: [], modules: ['hydroponics'] };
    renderAt('/dashboard/greenhouse');
    const preview = await waitFor(() => {
      const found = document.querySelector('[data-preview-finding]');
      if (found === null) throw new Error('no preview yet');
      return found;
    });
    expect(preview.getAttribute('data-preview-finding')).toBe('FARM-MEDIUM-443');
    expect(within(preview as HTMLElement).getByText('Söke · Zone 2')).toBeInTheDocument();
    await waitFor(() => expect(operations()).toContain('DashboardModuleAlarms'));
    const alarmRequest = requestOf('DashboardModuleAlarms');
    expect(alarmRequest?.variables?.['module']).toBe('HYDROPONICS');
    // No farm or sensor site rows are fetched for the greenhouse table.
    expect(operations()).not.toContain('DashboardSiteDayPlans');
  });
});
