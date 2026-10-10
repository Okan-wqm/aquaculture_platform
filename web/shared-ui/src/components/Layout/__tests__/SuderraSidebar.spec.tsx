/**
 * SuderraSidebar — the tenant console rail (FE-HIGH-313).
 *
 * Pins the rail's own contract (sections, the open model, groups, access) and
 * the phone overlay it shares with Sidebar through navShared.ts.
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SuderraSidebar, type SuderraNavSection } from '../SuderraSidebar';

class FakeMediaQueryList extends EventTarget implements MediaQueryList {
  readonly media: string;
  onchange: ((this: MediaQueryList, ev: MediaQueryListEvent) => unknown) | null = null;

  constructor(query: string) {
    super();
    this.media = query;
  }

  get matches(): boolean {
    return desktopMatches;
  }

  addListener(): void {
    // legacy API; the rail subscribes through addEventListener
  }

  removeListener(): void {
    // legacy API; the rail subscribes through addEventListener
  }
}

let desktopMatches = false;
let lastQuery: FakeMediaQueryList | undefined;

beforeEach(() => {
  desktopMatches = false;
  lastQuery = undefined;
  window.matchMedia = (query: string): MediaQueryList => {
    lastQuery = new FakeMediaQueryList(query);
    return lastQuery;
  };
});
afterEach(cleanup);

const sections: SuderraNavSection[] = [
  {
    id: 'overview',
    label: 'Overview',
    items: [{ id: 'dash', label: 'Dashboard', path: '/tenant', icon: 'gauge' }],
  },
  {
    id: 'modules',
    label: 'Modules',
    items: [
      {
        id: 'farm',
        label: 'Farm',
        icon: 'waves',
        children: [
          { id: 'tanks', label: 'Tanks', path: '/sites/tanks', icon: 'droplet' },
          { id: 'feeding', label: 'Feeding', path: '/sites/feeding', icon: 'wheat' },
        ],
      },
    ],
  },
  {
    id: 'account',
    label: 'Account',
    items: [
      {
        id: 'billing',
        label: 'Billing',
        path: '/tenant/billing',
        icon: 'card',
        requiredRoles: ['TENANT_ADMIN'],
      },
    ],
  },
];

interface Rendered {
  onNavigate: ReturnType<typeof vi.fn>;
  onMobileOpenChange: ReturnType<typeof vi.fn>;
}

function renderRail(
  overrides: Partial<React.ComponentProps<typeof SuderraSidebar>> = {},
): Rendered {
  const onNavigate = vi.fn();
  const onMobileOpenChange = vi.fn();
  render(
    <SuderraSidebar
      id="main-navigation"
      sections={sections}
      activePath="/tenant"
      onNavigate={onNavigate}
      userRoles={['TENANT_ADMIN']}
      brandName="Acme Fish"
      brandSub="Tenant console"
      logoSrc="/logo4-mark.png"
      mobileOpen={false}
      onMobileOpenChange={onMobileOpenChange}
      {...overrides}
    />,
  );
  return { onNavigate, onMobileOpenChange };
}

function rail(): HTMLElement {
  return screen.getByRole('complementary', { name: 'Main navigation' });
}

describe('SuderraSidebar', () => {
  it('starts as a closed icon rail whose items keep their accessible names', () => {
    renderRail();
    expect(rail().getAttribute('data-open')).toBe('false');
    expect(rail().className).toContain('md:w-[68px]');
    // Labels are visually hidden, not removed: the icon buttons stay named.
    expect(screen.getByRole('button', { name: 'Dashboard' })).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Overview' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Keep sidebar open' })).toBeNull();
  });

  it('opens while hovered and closes again when the pointer leaves', () => {
    renderRail();
    fireEvent.mouseEnter(rail());
    expect(rail().getAttribute('data-open')).toBe('true');
    expect(rail().className).toContain('md:w-[264px]');
    fireEvent.mouseLeave(rail());
    expect(rail().getAttribute('data-open')).toBe('false');
  });

  it('opens while keyboard focus is inside it', () => {
    renderRail();
    act(() => {
      screen.getByRole('button', { name: 'Dashboard' }).focus();
    });
    expect(rail().getAttribute('data-open')).toBe('true');
  });

  it('closes when the pointer leaves after a click — pointer focus does not hold it open', () => {
    renderRail();
    fireEvent.mouseEnter(rail());
    const billing = screen.getByRole('button', { name: 'Billing' });
    fireEvent.pointerDown(billing);
    act(() => {
      billing.focus();
    });
    fireEvent.pointerUp(billing);
    fireEvent.click(billing);
    fireEvent.mouseLeave(rail());
    expect(rail().getAttribute('data-open')).toBe('false');
  });

  it.each([
    ['released outside the rail', (): void => void fireEvent.pointerUp(document.body)],
    [
      'cancelled (a touch that became a scroll)',
      (): void => void fireEvent.pointerCancel(document),
    ],
  ])('a press %s does not swallow the next keyboard focus', (_case, end) => {
    renderRail();
    const billing = screen.getByRole('button', { name: 'Billing' });
    fireEvent.pointerDown(billing);
    end();
    act(() => {
      billing.focus();
    });
    expect(rail().getAttribute('data-open')).toBe('true');
  });

  it('stops listening for releases once unmounted', () => {
    const remove = vi.spyOn(document, 'removeEventListener');
    renderRail();
    cleanup();
    const removed = remove.mock.calls.map(([type]) => type);
    expect(removed).toEqual(expect.arrayContaining(['pointerup', 'pointercancel']));
    remove.mockRestore();
  });

  it('stays open once pinned, after the pointer leaves', () => {
    renderRail();
    fireEvent.mouseEnter(rail());
    const pin = screen.getByRole('button', { name: 'Keep sidebar open' });
    expect(pin.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(pin);
    fireEvent.mouseLeave(rail());
    expect(rail().getAttribute('data-open')).toBe('true');
    expect(screen.getByRole('button', { name: 'Unpin sidebar' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
  });

  it('marks the current page and navigates on click', () => {
    const { onNavigate } = renderRail();
    expect(screen.getByRole('button', { name: 'Dashboard' }).getAttribute('aria-current')).toBe(
      'page',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Billing' }));
    expect(onNavigate).toHaveBeenCalledWith('/tenant/billing');
  });

  it('opens the group of the active child and toggles groups on click', () => {
    renderRail({ activePath: '/sites/tanks' });
    fireEvent.mouseEnter(rail());
    const farm = screen.getByRole('button', { name: 'Farm' });
    expect(farm.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('button', { name: 'Tanks' }).getAttribute('aria-current')).toBe('page');
    fireEvent.click(farm);
    expect(farm.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('button', { name: 'Feeding' })).toBeNull();
  });

  it('hides items and empty sections the user may not see', () => {
    renderRail({ userRoles: ['MODULE_USER'] });
    expect(screen.queryByRole('button', { name: 'Billing' })).toBeNull();
    expect(screen.queryByRole('group', { name: 'Account' })).toBeNull();
  });

  it('is off-canvas on a phone until opened, then an overlay with labels', () => {
    renderRail({ mobileOpen: true });
    expect(rail().className).toContain('fixed inset-y-0 left-0 z-50');
    expect(rail().getAttribute('data-open')).toBe('true');
    expect(within(rail()).getByText('Acme Fish')).toBeTruthy();
  });

  it('closes the overlay from the backdrop, the close button, Escape and navigation', () => {
    const { onMobileOpenChange, onNavigate } = renderRail({ mobileOpen: true });
    fireEvent.click(screen.getByTestId('sidebar-backdrop'));
    fireEvent.click(screen.getByRole('button', { name: 'Close navigation' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onMobileOpenChange).toHaveBeenCalledTimes(3);
    fireEvent.click(screen.getByRole('button', { name: 'Billing' }));
    expect(onNavigate).toHaveBeenCalledWith('/tenant/billing');
    expect(onMobileOpenChange).toHaveBeenCalledTimes(4);
    expect(onMobileOpenChange).toHaveBeenLastCalledWith(false);
  });

  it('closes the overlay when the viewport grows past md', () => {
    const { onMobileOpenChange } = renderRail({ mobileOpen: true });
    act(() => {
      desktopMatches = true;
      lastQuery?.dispatchEvent(new Event('change'));
    });
    expect(onMobileOpenChange).toHaveBeenLastCalledWith(false);
  });
});
