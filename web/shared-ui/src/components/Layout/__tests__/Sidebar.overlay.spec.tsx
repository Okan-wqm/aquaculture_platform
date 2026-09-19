/**
 * Sidebar — the off-canvas overlay below `md` (FE-HIGH-088).
 *
 * The sidebar was an in-flow w-64 column at every width, leaving 111 px of
 * content on a 375 px phone, and the shell's hamburger only toggled the rail.
 * These tests pin the overlay contract: hidden until opened, a backdrop and a
 * close button that close it, Escape closes it, choosing a destination closes
 * it, the viewport growing past `md` closes it, and the overlay always shows
 * labels even while the desktop column is collapsed to its rail.
 */
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Sidebar } from '../Sidebar';

/**
 * A MediaQueryList the sidebar can subscribe to. `matches` reads the module
 * flag so a test flips the viewport, then dispatches `change` on the instance
 * the sidebar holds — the same object shape a browser hands out, no cast.
 */
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
    // legacy API; the sidebar subscribes through addEventListener
  }

  removeListener(): void {
    // legacy API; the sidebar subscribes through addEventListener
  }
}

let desktopMatches = false;
let lastQuery: FakeMediaQueryList | undefined;

function installMatchMedia(): void {
  desktopMatches = false;
  lastQuery = undefined;
  window.matchMedia = (query: string): MediaQueryList => {
    lastQuery = new FakeMediaQueryList(query);
    return lastQuery;
  };
}

function currentQuery(): FakeMediaQueryList {
  if (!lastQuery) throw new Error('the sidebar did not call matchMedia');
  return lastQuery;
}

const items = [
  { id: 'home', label: 'Dashboard', path: '/dashboard', icon: 'dashboard' },
  { id: 'farm', label: 'Sites', path: '/sites', icon: 'farm' },
];

function renderSidebar(overrides: Partial<React.ComponentProps<typeof Sidebar>> = {}): {
  onMobileOpenChange: ReturnType<typeof vi.fn>;
  onNavigate: ReturnType<typeof vi.fn>;
} {
  const onMobileOpenChange = vi.fn();
  const onNavigate = vi.fn();
  render(
    <Sidebar
      id="main-navigation"
      items={items}
      activePath="/dashboard"
      onNavigate={onNavigate}
      mobileOpen={false}
      onMobileOpenChange={onMobileOpenChange}
      {...overrides}
    />,
  );
  return { onMobileOpenChange, onNavigate };
}

beforeEach(installMatchMedia);
afterEach(cleanup);

describe('Sidebar overlay below md', () => {
  it('is off-canvas until opened and an in-flow column above md', () => {
    renderSidebar();
    const aside = screen.getByRole('complementary', { name: 'Main navigation' });
    expect(aside.className).toContain('hidden md:flex');
    expect(aside.id).toBe('main-navigation');
    expect(screen.queryByTestId('sidebar-backdrop')).toBeNull();
  });

  it('opens as a fixed overlay over a backdrop; backdrop and close button both close it', () => {
    const { onMobileOpenChange } = renderSidebar({ mobileOpen: true });
    const aside = screen.getByRole('complementary', { name: 'Main navigation' });
    expect(aside.className).toContain('fixed inset-y-0 left-0 z-50 w-64');
    expect(aside.className).toContain('md:static');

    fireEvent.click(screen.getByTestId('sidebar-backdrop'));
    expect(onMobileOpenChange).toHaveBeenLastCalledWith(false);

    fireEvent.click(screen.getByRole('button', { name: 'Close navigation' }));
    expect(onMobileOpenChange).toHaveBeenCalledTimes(2);
  });

  it('closes on Escape', () => {
    const { onMobileOpenChange } = renderSidebar({ mobileOpen: true });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onMobileOpenChange).toHaveBeenLastCalledWith(false);
  });

  it('closes when a destination is chosen, after navigating', () => {
    const { onMobileOpenChange, onNavigate } = renderSidebar({ mobileOpen: true });
    fireEvent.click(screen.getByRole('button', { name: 'Sites' }));
    expect(onNavigate).toHaveBeenCalledWith('/sites');
    expect(onMobileOpenChange).toHaveBeenLastCalledWith(false);
  });

  it('does not close the in-flow column on navigation', () => {
    const { onMobileOpenChange, onNavigate } = renderSidebar({ mobileOpen: false });
    fireEvent.click(screen.getByRole('button', { name: 'Sites' }));
    expect(onNavigate).toHaveBeenCalledWith('/sites');
    expect(onMobileOpenChange).not.toHaveBeenCalled();
  });

  it('closes itself when the viewport grows past md', () => {
    const { onMobileOpenChange } = renderSidebar({ mobileOpen: true });
    expect(onMobileOpenChange).not.toHaveBeenCalled();
    act(() => {
      desktopMatches = true;
      currentQuery().dispatchEvent(new Event('change'));
    });
    expect(onMobileOpenChange).toHaveBeenLastCalledWith(false);
  });

  it('shows labels in the overlay even while the desktop column is a rail', () => {
    renderSidebar({ mobileOpen: true, collapsed: true, onCollapsedChange: vi.fn() });
    expect(screen.getByText('Sites')).toBeTruthy();
    const aside = screen.getByRole('complementary', { name: 'Main navigation' });
    expect(aside.className).toContain('md:w-16');
    // The collapse toggle is the column's control and stays off the phone overlay.
    expect(screen.getByRole('button', { name: 'Expand sidebar' }).className).toContain('hidden md:inline-flex');
  });

  it('hides labels in the rail when the overlay is closed', () => {
    renderSidebar({ mobileOpen: false, collapsed: true, onCollapsedChange: vi.fn() });
    expect(screen.queryByText('Sites')).toBeNull();
  });
});
