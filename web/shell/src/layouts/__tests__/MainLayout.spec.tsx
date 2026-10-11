/**
 * MainLayout — which navigation each role gets (FE-HIGH-313): the SUPER_ADMIN
 * console keeps Sidebar on the neutral canvas; every tenant-side role gets the
 * Suderra rail over the paper content column, with the hamburger wired to it.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  role: 'TENANT_ADMIN' as 'SUPER_ADMIN' | 'TENANT_ADMIN' | 'MODULE_USER',
  permissions: [] as string[],
}));

vi.mock('@aquaculture/shared-ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aquaculture/shared-ui')>();
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
      },
      logout: vi.fn(),
      modules: [{ code: 'farm' }],
    }),
    useAuth: () => ({ hasPermission: (cap: string): boolean => harness.permissions.includes(cap) }),
    useTenantContext: () => ({ tenant: { id: 't1', name: 'Acme Fish' } }),
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

import MainLayout, { MODULE_NAV_CONFIG } from '../MainLayout';

function renderLayout(path = '/tenant'): ReturnType<typeof render> {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route element={<MainLayout />}>
            <Route path="*" element={<div>Page body</div>} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  harness.role = 'TENANT_ADMIN';
  harness.permissions = [];
  preloadRoute.mockClear();
});
afterEach(cleanup);

describe('MainLayout navigation per role', () => {
  it('gives a tenant admin the Suderra rail, grouped, over the paper column', () => {
    const { container } = renderLayout();
    const rail = screen.getByRole('complementary', { name: 'Main navigation' });
    expect(rail.hasAttribute('data-open')).toBe(true);
    expect(screen.getByRole('group', { name: 'People & access' })).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Account' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Devices' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Dashboard' }).getAttribute('aria-current')).toBe(
      'page',
    );
    expect(container.querySelector('.sd-content')).not.toBeNull();
    expect(container.querySelector('main.sd-main')).not.toBeNull();
    expect(screen.getByText('Page body')).toBeTruthy();
  });

  it('opens the rail as the phone overlay from the hamburger', () => {
    renderLayout();
    fireEvent.click(screen.getByRole('button', { name: 'Open navigation' }));
    const rail = screen.getByRole('complementary', { name: 'Main navigation' });
    expect(rail.className).toContain('fixed inset-y-0 left-0 z-50');
  });

  it('shows a module user only the tenant entries their role delegates', () => {
    harness.role = 'MODULE_USER';
    harness.permissions = ['users:view'];
    renderLayout('/dashboard');
    expect(screen.getByRole('button', { name: 'Users' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Roles & Permissions' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Devices' })).toBeNull();
  });

  it('keeps the SUPER_ADMIN console on Sidebar and the neutral canvas', () => {
    harness.role = 'SUPER_ADMIN';
    const { container } = renderLayout('/admin');
    expect(
      screen.getByRole('complementary', { name: 'Main navigation' }).hasAttribute('data-open'),
    ).toBe(false);
    expect(screen.queryByRole('group', { name: 'Account' })).toBeNull();
    expect(container.querySelector('.sd-content')).toBeNull();
  });
});

describe('MODULE_NAV_CONFIG sidebar targets are redirect-free (E2E-FLAKE)', () => {
  // Route SOURCES farm-module's Module.tsx answers with a <Navigate> — kept
  // there for URL/bookmark compatibility, but a sidebar entry pointing at one
  // pays an extra render + remount before the real page mounts, which is the
  // window Playwright clicks time out in. If a child regresses onto one of
  // these, point it at the Navigate TARGET instead (and keep this list in
  // sync with Module.tsx's redirect routes).
  const REDIRECT_SOURCES = [
    '/sites/map',
    '/sites/new',
    '/sites/sensors',
    '/sites/cleaner-fish',
    '/sites/feeding/records',
    '/sites/feeding/protocols/new',
    '/sites/production',
  ];

  it('points every farm child straight at its final destination', () => {
    const farmChildren = MODULE_NAV_CONFIG.farm.children ?? [];
    expect(farmChildren.length).toBeGreaterThan(0);
    for (const child of farmChildren) {
      expect(child.path, `${child.id} must declare a path`).toBeDefined();
      for (const source of REDIRECT_SOURCES) {
        expect(
          child.path === source || child.path?.startsWith(`${source}/`),
          `${child.id} -> ${child.path} passes through the ${source} redirect`,
        ).toBe(false);
      }
    }
  });

  it('targets the feeding records tab URL directly, not the redirect route', () => {
    const records = MODULE_NAV_CONFIG.farm.children?.find(
      (child) => child.id === 'sites-feeding-records',
    );
    expect(records?.path).toBe('/sites/feeding?tab=records');
  });
});

describe('MainLayout hover route preload (E2E-FLAKE)', () => {
  it('preloads the hovered module child destination chunk', () => {
    renderLayout('/sites/tanks');
    // Open the rail so the Farm group's children render, then hover the
    // records entry: hover is the intent signal that warms the lazy chunk.
    fireEvent.mouseEnter(screen.getByRole('complementary', { name: 'Main navigation' }));
    fireEvent.mouseEnter(screen.getByRole('button', { name: 'Feed Records & Inventory' }));
    expect(preloadRoute).toHaveBeenCalledWith('/sites/feeding?tab=records');
  });
});
