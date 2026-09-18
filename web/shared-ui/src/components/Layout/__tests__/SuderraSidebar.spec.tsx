/**
 * SuderraSidebar — SUDERRA tenant console rail behaviour.
 *
 * Covers the mockup-parity contract: collapsed icon rail by default,
 * hover-expand opens the drawer, section labels only render while open,
 * leaf items navigate, module groups auto-open when a child route is active.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import { SuderraSidebar, type SuderraNavSection } from '../SuderraSidebar';

const sections: SuderraNavSection[] = [
  {
    id: 'sec-overview',
    label: 'Overview',
    items: [
      { id: 'tenant-dashboard', label: 'Dashboard', path: '/tenant', icon: 'gauge' },
      { id: 'messaging', label: 'Messages', path: '/messaging', icon: 'chat', badge: 4 },
    ],
  },
  {
    id: 'sec-modules',
    label: 'Modules',
    items: [
      {
        id: 'farm-module',
        label: 'Site management',
        icon: 'waves',
        children: [
          { id: 'sites-tanks', label: 'Tanks & ponds', path: '/sites/tanks', icon: 'droplet' },
          { id: 'sites-setup', label: 'Setup', path: '/sites/setup', icon: 'wrench' },
        ],
      },
    ],
  },
];

const renderRail = (activePath?: string) => {
  const onNavigate = vi.fn();
  const { container } = render(
    <SuderraSidebar
      sections={sections}
      activePath={activePath}
      onNavigate={onNavigate}
      brandName="Suderra Aqua"
      brandSub="Tenant console"
      statusText="3 sites · 41 tanks live"
    />,
  );
  return { container, onNavigate };
};

const rail = (container: HTMLElement): HTMLElement => {
  const el = container.querySelector('.sd-rail');
  if (!el) throw new Error('sd-rail not rendered');
  return el as HTMLElement;
};

describe('SuderraSidebar', () => {
  it('renders collapsed by default — no labels, no section headers', () => {
    const { container } = renderRail();
    const el = rail(container);

    expect(el.getAttribute('data-open')).toBe('false');
    expect(screen.queryByText('Dashboard')).toBeNull();
    expect(screen.queryByText('Overview')).toBeNull();
    // Collapsed sections render hairlines instead of labels.
    expect(el.querySelectorAll('.sd-rail-hairline')).toHaveLength(2);
    // Titles keep items identifiable while collapsed.
    expect(screen.getAllByTitle('Dashboard')).toHaveLength(1);
  });

  it('expands on hover — labels, section headers and status appear', () => {
    const { container } = renderRail();
    const el = rail(container);

    fireEvent.mouseEnter(el);
    expect(el.getAttribute('data-open')).toBe('true');
    expect(screen.getByText('Dashboard')).toBeTruthy();
    expect(screen.getByText('Overview')).toBeTruthy();
    expect(screen.getByText('3 sites · 41 tanks live')).toBeTruthy();
    expect(screen.getByText('Suderra Aqua')).toBeTruthy();
    expect(screen.getByText('Tenant console')).toBeTruthy();

    fireEvent.mouseLeave(el);
    expect(el.getAttribute('data-open')).toBe('false');
  });

  it('navigates on leaf click and renders the badge chip', () => {
    const { container, onNavigate } = renderRail();
    fireEvent.mouseEnter(rail(container));

    fireEvent.click(screen.getByRole('button', { name: 'Dashboard' }));
    expect(onNavigate).toHaveBeenCalledWith('/tenant');

    expect(screen.getByText('4')).toBeTruthy();
  });

  it('auto-opens a module group whose child route is active', () => {
    const { container, onNavigate } = renderRail('/sites/tanks');
    fireEvent.mouseEnter(rail(container));

    // Group is expanded because the active path is one of its children.
    expect(screen.getByText('Tanks & ponds')).toBeTruthy();
    expect(screen.getByText('Setup')).toBeTruthy();

    // Child navigation works and the active child is marked.
    fireEvent.click(screen.getByRole('button', { name: 'Setup' }));
    expect(onNavigate).toHaveBeenCalledWith('/sites/setup');
    expect(screen.getByRole('button', { name: 'Tanks & ponds' }).getAttribute('aria-current')).toBe(
      'page',
    );
  });

  it('toggles a module group closed and back open', () => {
    const { container } = renderRail('/sites/tanks');
    fireEvent.mouseEnter(rail(container));

    fireEvent.click(screen.getByRole('button', { name: 'Site management' }));
    expect(screen.queryByText('Tanks & ponds')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Site management' }));
    expect(screen.getByText('Tanks & ponds')).toBeTruthy();
  });

  it('pins open via the pin button (stays open after mouse leaves)', () => {
    const { container } = renderRail();
    const el = rail(container);
    fireEvent.mouseEnter(el);

    fireEvent.click(screen.getByTitle('Keep sidebar open'));
    fireEvent.mouseLeave(el);
    expect(el.getAttribute('data-open')).toBe('true');
  });

  it('hides items the user lacks roles for', () => {
    const gated: SuderraNavSection[] = [
      {
        id: 'sec-account',
        label: 'Account',
        items: [
          {
            id: 'tenant-billing',
            label: 'Billing',
            path: '/tenant/billing',
            icon: 'card',
            requiredRoles: ['TENANT_ADMIN', 'SUPER_ADMIN'],
          },
          { id: 'tenant-settings', label: 'Settings', path: '/tenant/settings', icon: 'sliders' },
        ],
      },
    ];
    const { container } = render(
      <SuderraSidebar
        sections={gated}
        onNavigate={() => {}}
        brandName="T"
        userRoles={['MODULE_MANAGER']}
      />,
    );
    fireEvent.mouseEnter(rail(container));

    expect(screen.queryByTitle('Billing')).toBeNull();
    expect(screen.getByTitle('Settings')).toBeTruthy();
  });
});
