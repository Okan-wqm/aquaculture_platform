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

import MainLayout from '../MainLayout';

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
