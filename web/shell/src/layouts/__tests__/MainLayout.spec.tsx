/**
 * MainLayout — which console each role gets (FE-HIGH-334): SUPER_ADMIN keeps
 * the admin Sidebar and Header on the neutral canvas; every tenant-side role
 * gets the tenant console — the Industrial rail built from the console nav
 * model, the console header (one h1: the page's), the annunciator, the
 * command palette and the user menu — over the `.sd-content` column.
 */
import '@testing-library/jest-dom/vitest';
import {
  CONSOLE_WORKSPACE_IDS,
  PageHeader,
  RouteAnnouncer,
  type ConsoleWorkspaceId,
} from '@aquaculture/shared-ui';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  role: 'TENANT_ADMIN' as 'SUPER_ADMIN' | 'TENANT_ADMIN' | 'MODULE_USER',
  permissions: [] as string[],
  modules: [{ code: 'farm' }, { code: 'sensor' }] as { code: string }[],
  logout: vi.fn(async (): Promise<void> => undefined),
}));

vi.mock('@aquaculture/shared-ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aquaculture/shared-ui')>();
  const hasPermission = (cap: string): boolean =>
    harness.role === 'TENANT_ADMIN' || harness.permissions.includes(cap);
  return {
    ...actual,
    useAuthContext: () => ({
      user: {
        id: 'u1',
        email: 'admin@example.com',
        firstName: 'Ada',
        lastName: 'Admin',
        role: harness.role,
        tenantId: 't1',
        // The session names the tenant (`me`); the rail reads it from here.
        tenantName: 'Acme Fish',
      },
      logout: harness.logout,
      modules: harness.modules,
      refreshAuth: vi.fn(),
    }),
    useAuth: () => ({
      hasPermission,
      tenantId: 't1',
      token: 'tok',
      isTenantAdmin: harness.role === 'TENANT_ADMIN',
    }),
    // What production holds for a tenant role: TenantContext is filled only
    // while a SUPER_ADMIN acts as a tenant, so nothing may read the name here.
    useTenantContext: () => ({ tenant: null }),
  };
});

// The console's data reads are their own specs' subject (console/data); here
// they answer with fixed real-shaped results.
vi.mock('../../console/data', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../console/data')>();
  return {
    ...actual,
    useAlarmSummary: () => ({
      status: 'ready',
      p1: 2,
      p2: 0,
      p3: 1,
      unack: 3,
      p1Unack: 1,
    }),
    useDeviceStatus: () => ({ status: 'ready', online: 3, total: 4 }),
    useSiteStatus: () => ({ status: 'unavailable', live: null, total: null }),
    usePaletteSources: () => ({
      people: { status: 'unavailable', items: null },
      devices: { status: 'unavailable', items: null },
    }),
    useViewAsRoles: () => ({
      status: 'ready',
      roles: [
        {
          id: 'r-op',
          name: 'Operator',
          description: null,
          color: 'green',
          level: 30,
          isSystem: true,
          resourcePermissions: [],
        },
      ],
    }),
  };
});
vi.mock('@/components/NotificationPanel', () => ({ NotificationPanel: (): null => null }));
vi.mock('../../components/ConsentBanner', () => ({ default: (): null => null }));
vi.mock('../../components/ActAsTenantBanner', () => ({ ActAsTenantBanner: (): null => null }));
vi.mock('../../components/UserLocaleSync', () => ({ UserLocaleSync: (): null => null }));
vi.mock('../../components/ai/AiAssistantDrawer', () => ({ default: (): null => null }));
// E2E-FLAKE: the hover-preload wiring is asserted with a mock so the spec
// never reaches for the federation remote itself.
const preloadRoute = vi.hoisted(() => vi.fn());
vi.mock('../../utils/routePreload', () => ({ preloadRoute }));

import { buildConsoleNav } from '../../console/nav';
import MainLayout from '../MainLayout';

/** Where the router is — what a navigation landed on. */
function LocationProbe(): React.ReactElement {
  const location = useLocation();
  return <output data-testid="location">{`${location.pathname}${location.search}`}</output>;
}

function Page({ title }: { title?: string }): React.ReactElement {
  return (
    <div>
      {title !== undefined && <PageHeader title={title} description="Page description" />}
      <p>Page body</p>
      <LocationProbe />
    </div>
  );
}

function renderLayout(
  path = '/tenant',
  pageTitle?: string,
  client = new QueryClient(),
): ReturnType<typeof render> {
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route element={<MainLayout />}>
            <Route path="*" element={<Page title={pageTitle} />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function location(): string {
  return screen.getByTestId('location').textContent ?? '';
}

/** The main navigation: a landmark in the column, a modal dialog as the phone overlay. */
function rail(): HTMLElement {
  return (
    screen.queryByRole('dialog', { name: 'Main navigation' }) ??
    screen.getByRole('navigation', { name: 'Main navigation' })
  );
}

beforeEach(() => {
  harness.role = 'TENANT_ADMIN';
  harness.permissions = [];
  harness.modules = [{ code: 'farm' }, { code: 'sensor' }];
  harness.logout.mockClear();
  preloadRoute.mockClear();
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('MainLayout — the tenant console', () => {
  it('frames a tenant admin with the rail and the console header over the paper column', () => {
    const { container } = renderLayout('/tenant');
    expect(rail().getAttribute('data-collapsed')).toBe('false');
    // The tenant line comes from the session, with TenantContext empty as in production.
    expect(within(rail()).getByText('Acme Fish')).toBeTruthy();
    expect(container.querySelector('.sd-content')).not.toBeNull();
    // The page column follows the window: it fills the content column, so it grows and
    // shrinks with it. No fixed pixel cap, and it is not centred in a capped box either.
    const main = screen.getByRole('main');
    expect(main).toHaveClass('sd-main', 'w-full');
    expect(main).not.toHaveClass('mx-auto');
    expect(
      [...main.classList].filter((name) => /^max-w-\[\d+px\]$/.test(name)),
      'a fixed pixel max-width freezes the page while the window grows',
    ).toEqual([]);
    // The header names the page from the nav, under "Workspace · Area".
    expect(screen.getByRole('heading', { level: 1, name: 'Company dashboard' })).toBeTruthy();
    expect(screen.getByText('Company · Overview')).toBeTruthy();
    expect(within(rail()).getByRole('link', { name: 'Company dashboard' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(screen.getByText('Page body')).toBeTruthy();
  });

  it('keeps exactly one h1: the page title the console header shows', () => {
    renderLayout('/sites/tanks', 'Tanks');
    const headings = screen.getAllByRole('heading', { level: 1 });
    expect(headings).toHaveLength(1);
    expect(headings[0]).toHaveTextContent('Tanks & Ponds');
    // The PageHeader keeps its description; its title is read, not drawn.
    expect(screen.getByText('Page description')).toBeTruthy();
    expect(screen.getByText('Tanks')).toHaveClass('sr-only');
  });

  it('names a record with its own h2 under the console h1 on a detail route', () => {
    renderLayout('/sites/batch/b-1/feeding', 'Batch B-1');
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Tanks & Ponds');
    const record = screen.getByRole('heading', { level: 2, name: 'Batch B-1' });
    expect(record).not.toHaveClass('sr-only');
  });

  it('follows navigation into the owning workspace, switches the accent ramp and stores it', () => {
    const { unmount } = renderLayout('/sites/tanks');
    expect(document.documentElement.dataset.ws).toBe('aqua');
    expect(localStorage.getItem('aqua.tss::t1::suderra.console.ws')).toBe('"aqua"');
    unmount();
    expect(document.documentElement.dataset.ws).toBeUndefined();
  });

  it('opens a workspace on its home page from the module menu', async () => {
    const user = userEvent.setup();
    renderLayout('/sites/tanks');
    await user.click(
      within(rail()).getByRole('button', { name: 'Acme Fish, Production — switch module' }),
    );
    const menu = screen.getByRole('dialog', { name: 'Module' });
    await user.click(within(menu).getByRole('button', { name: /^Company/ }));
    expect(location()).toBe('/tenant');
    expect(document.documentElement.dataset.ws).toBe('org');
  });

  it('opens the rail as the phone overlay from the header hamburger', () => {
    renderLayout();
    const toggle = screen.getByRole('button', { name: 'Open navigation' });
    expect(
      within(screen.getByRole('banner')).getByRole('button', { name: 'Open navigation' }),
    ).toBe(toggle);
    fireEvent.click(toggle);
    const overlay = screen.getByRole('dialog', { name: 'Main navigation' });
    expect(overlay).toHaveAttribute('aria-modal', 'true');
    expect(overlay.className).toContain('fixed inset-y-0 left-0 z-50');
  });

  it('shows a module user only the tenant pages their role delegates', () => {
    harness.role = 'MODULE_USER';
    harness.permissions = ['users:view'];
    harness.modules = [{ code: 'farm' }];
    renderLayout('/tenant/users');
    expect(within(rail()).getByRole('link', { name: 'Users' })).toBeTruthy();
    expect(within(rail()).queryByRole('link', { name: 'Roles & Permissions' })).toBeNull();
    expect(within(rail()).queryByRole('link', { name: 'Devices' })).toBeNull();
    expect(within(rail()).queryByRole('link', { name: 'Billing & subscription' })).toBeNull();
  });

  // primary-600 on the dark ghost hover fill was about 2:1 (WCAG 1.4.11: 3:1 for an icon).
  it('gives the AI trigger a hover colour of its own in the dark theme', () => {
    renderLayout('/tenant');
    expect(screen.getByRole('button', { name: 'Open AI assistant' })).toHaveClass(
      'dark:hover:text-primary-300',
    );
  });

  it('preloads the hovered entry destination chunk (E2E-FLAKE)', () => {
    renderLayout('/sites/tanks');
    fireEvent.mouseEnter(within(rail()).getByRole('link', { name: 'Tanks & Ponds' }));
    expect(preloadRoute).toHaveBeenCalledWith('/sites/tanks');
  });
});

describe('MainLayout — annunciator, palette, user menu', () => {
  it('opens the alarm list filtered by a tile, and clears it from the same tile', async () => {
    const user = userEvent.setup();
    renderLayout('/sites/tanks');
    const strip = screen.getByRole('region', { name: 'Alarm summary' });
    await user.click(within(strip).getByRole('button', { name: /Critical/ }));
    expect(location()).toBe('/sensor/alerts?priority=p1');
    expect(within(strip).getByRole('button', { name: /Critical/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await user.click(within(strip).getByRole('button', { name: /Critical/ }));
    expect(location()).toBe('/sensor/alerts');
  });

  it('draws no annunciator for a viewer with no alarm list', () => {
    harness.modules = [{ code: 'farm' }];
    harness.role = 'MODULE_USER';
    renderLayout('/sites/tanks');
    expect(screen.queryByRole('region', { name: 'Alarm summary' })).toBeNull();
  });

  it('opens the command palette from Ctrl+K and goes to the page picked', async () => {
    const user = userEvent.setup();
    renderLayout('/tenant');
    act(() => {
      fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    });
    const palette = await screen.findByRole('dialog', { name: 'Command palette' });
    await user.type(within(palette).getByRole('combobox'), 'Tanks & Ponds');
    await user.keyboard('{Enter}');
    expect(screen.queryByRole('dialog', { name: 'Command palette' })).toBeNull();
    expect(location()).toBe('/sites/tanks');
  });

  it("previews a role's console from the user menu, and returns from the banner", async () => {
    const user = userEvent.setup();
    renderLayout('/tenant/billing');
    expect(within(rail()).getByRole('link', { name: 'Billing & subscription' })).toBeTruthy();
    // The banner's live region is in the page before any preview, so the
    // first switch is a change inside it — which screen readers announce.
    const regionsBefore = screen.getAllByRole('status');

    await user.click(screen.getByRole('button', { name: 'User menu, Ada Admin' }));
    const roles = screen.getByRole('group', { name: 'View as role' });
    await user.click(within(roles).getByRole('button', { name: /Operator/ }));

    const announcing = screen
      .getAllByRole('status')
      .find((region) => /Viewing as Operator/.test(region.textContent ?? ''));
    expect(announcing).toBeDefined();
    expect(regionsBefore).toContain(announcing);
    // The preview cannot open billing: it lands where an operator would.
    expect(location()).not.toBe('/tenant/billing');
    expect(within(rail()).queryByRole('link', { name: 'Billing & subscription' })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Exit role view' }));
    expect(screen.queryByText('Viewing as Operator')).toBeNull();
    // The exit button leaves with the banner; focus moves to the page, not the document body.
    expect(screen.getByRole('main')).toHaveFocus();
  });

  it('signs out through the layout logout: tenant cache purged, then /login', async () => {
    const user = userEvent.setup();
    const client = new QueryClient();
    const removeQueries = vi.spyOn(client, 'removeQueries');
    renderLayout('/tenant', undefined, client);
    await user.click(screen.getByRole('button', { name: 'User menu, Ada Admin' }));
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(harness.logout).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(location()).toBe('/login'));
    expect(removeQueries).toHaveBeenCalledWith({ queryKey: ['tenant', 't1'] });
  });
});

/**
 * The page's identity (WCAG 2.4.2, 4.1.3): the console names the page it
 * shows — tab, page, workspace, as the nav localized them — for the document
 * title and the route announcement, a `?tab=` change included.
 */
describe('MainLayout — page identity', () => {
  const APP_NAME = 'Aquaculture Platform';

  /** App.tsx's wiring: the router's path and query, handed to the announcer. */
  function Announced(): React.ReactElement {
    const { pathname, search } = useLocation();
    return (
      <RouteAnnouncer location={`${pathname}${search}`}>
        <Routes>
          <Route element={<MainLayout />}>
            <Route path="*" element={<Page />} />
          </Route>
        </Routes>
      </RouteAnnouncer>
    );
  }

  function renderAnnounced(path: string): void {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter initialEntries={[path]}>
          <Announced />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  }

  function announced(text: string): HTMLElement | undefined {
    return screen.getAllByRole('status').find((region) => region.textContent === text);
  }

  beforeEach(() => {
    document.title = APP_NAME;
  });

  it('titles the document after the console page and announces a tab change', async () => {
    const user = userEvent.setup();
    renderAnnounced('/sites/feeding');
    expect(document.title).toBe(`Feeding · Production · ${APP_NAME}`);
    // The first page is not announced: the screen reader reads the document title.
    expect(announced('Feeding · Production')).toBeUndefined();

    await user.click(within(rail()).getByRole('link', { name: 'Records' }));
    expect(location()).toBe('/sites/feeding?tab=records');
    expect(document.title).toBe(`Records · Feeding · Production · ${APP_NAME}`);
    expect(announced('Records · Feeding · Production')).toBeDefined();
  });

  it("names the SUPER_ADMIN console's pages from its own navigation", () => {
    harness.role = 'SUPER_ADMIN';
    renderAnnounced('/admin');
    expect(document.title).toBe(`Dashboard · ${APP_NAME}`);
  });
});

describe('MainLayout — the SUPER_ADMIN console', () => {
  it('keeps Sidebar and the neutral canvas, with no console chrome', () => {
    harness.role = 'SUPER_ADMIN';
    const { container } = renderLayout('/admin');
    expect(rail().hasAttribute('data-open')).toBe(false);
    expect(rail().hasAttribute('data-collapsed')).toBe(false);
    expect(container.querySelector('.sd-content')).toBeNull();
    expect(screen.queryByRole('region', { name: 'Alarm summary' })).toBeNull();
    expect(document.documentElement.dataset.ws).toBeUndefined();
    // The header's no-op search box is gone.
    expect(screen.queryByPlaceholderText(/search/i)).toBeNull();
  });
});

describe('console nav targets are redirect-free (E2E-FLAKE)', () => {
  // Route SOURCES farm-module's Module.tsx answers with a <Navigate> — kept
  // there for URL/bookmark compatibility, but an entry pointing at one pays an
  // extra render + remount before the real page mounts, which is the window
  // Playwright clicks time out in. tests/invariants/web-console-nav-coverage
  // .spec.ts holds every entry to a leaf route; this pins the known ones here,
  // beside the layout that renders the rail.
  const REDIRECT_SOURCES = [
    '/sites/map',
    '/sites/new',
    '/sites/sensors',
    '/sites/cleaner-fish',
    '/sites/feeding/records',
    '/sites/feeding/protocols/new',
    '/sites/production',
  ];

  it('points every page and tab a tenant admin sees at its final destination', () => {
    const nav = buildConsoleNav({
      role: 'TENANT_ADMIN',
      modules: ['farm', 'sensor', 'hr', 'hydroponics'].map((code) => ({ code })),
      hasPermission: () => true,
      t: (key) => key,
    });
    const workspaces: ConsoleWorkspaceId[] = nav.map((workspace) => workspace.id);
    expect(workspaces).toEqual([...CONSOLE_WORKSPACE_IDS]);
    const destinations = nav.flatMap((workspace) =>
      workspace.areas.flatMap((area) =>
        area.groups.flatMap((group) =>
          group.pages.flatMap((page) => [page.path, ...(page.tabs ?? []).map((tab) => tab.path)]),
        ),
      ),
    );
    expect(destinations.length).toBeGreaterThan(0);
    for (const destination of destinations) {
      const pathname = destination.split('?')[0] ?? destination;
      for (const source of REDIRECT_SOURCES) {
        expect(
          pathname === source || pathname.startsWith(`${source}/`),
          `${destination} passes through the ${source} redirect`,
        ).toBe(false);
      }
    }
  });

  it('targets the feeding records tab URL directly, not the redirect route', () => {
    const nav = buildConsoleNav({
      role: 'TENANT_ADMIN',
      modules: [{ code: 'farm' }],
      hasPermission: () => true,
      t: (key) => key,
    });
    // Records is a Feeding tab, as the design places it (digest §8.3 `feedrec`).
    const records = nav
      .flatMap((workspace) => workspace.areas)
      .flatMap((area) => area.groups)
      .flatMap((group) => group.pages)
      .find((page) => page.id === 'feeding')
      ?.tabs?.find((tab) => tab.id === 'records');
    expect(records?.path).toBe('/sites/feeding?tab=records');
  });
});
