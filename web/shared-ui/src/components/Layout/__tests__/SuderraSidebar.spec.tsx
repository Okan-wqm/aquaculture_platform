/**
 * SuderraSidebar — the tenant-console rail.
 *
 * Two kinds of contract are pinned here. The first is the rail's own behaviour:
 * it opens on hover, the pin keeps it open once the pointer leaves, groups
 * accordion open, a group whose child is the active route starts open, and an
 * item the user's roles do not reach is not rendered.
 *
 * The second is why this component looks the way it does. The design-mockup
 * version carried its own 42-icon SVG registry, a hand-painted pin and English
 * literals, each of which the design system already owns. Those are checked as
 * hard assertions — not style notes — because a later "just paste the mockup
 * back" is exactly how the three ratchets involved get raised by a component
 * that had no reason to touch them.
 */
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '../../../i18n';
import type { NavigationItem } from '../../../types';
import { SuderraSidebar, type SuderraNavSection } from '../SuderraSidebar';

afterEach(cleanup);

const item = (over: Partial<NavigationItem> & { id: string; label: string }): NavigationItem =>
  ({ icon: 'gauge', ...over }) as NavigationItem;

const SECTIONS: SuderraNavSection[] = [
  {
    id: 'operate',
    label: 'Operate',
    items: [
      item({ id: 'overview', label: 'Overview', path: '/overview' }),
      item({
        id: 'farm',
        label: 'Farm',
        path: '/farm',
        icon: 'waves',
        children: [
          item({ id: 'ponds', label: 'Ponds', path: '/farm/ponds' }),
          item({ id: 'batches', label: 'Batches', path: '/farm/batches' }),
        ],
      }),
    ],
  },
  {
    id: 'admin',
    label: 'Administration',
    items: [
      item({ id: 'billing', label: 'Billing', path: '/billing', requiredRoles: ['TENANT_ADMIN'] }),
    ],
  },
];

const renderRail = (props: Partial<React.ComponentProps<typeof SuderraSidebar>> = {}) =>
  render(
    <I18nProvider>
      <SuderraSidebar sections={SECTIONS} brandName="Acme Farms" onNavigate={vi.fn()} {...props} />
    </I18nProvider>,
  );

const rail = (): HTMLElement => screen.getByRole('complementary');

describe('SuderraSidebar', () => {
  it('is collapsed until hovered, and the pin keeps it open once the pointer leaves', () => {
    renderRail();
    expect(rail().dataset['open']).toBe('false');

    fireEvent.mouseEnter(rail());
    expect(rail().dataset['open']).toBe('true');

    fireEvent.click(screen.getByRole('button', { name: 'Keep sidebar open' }));
    fireEvent.mouseLeave(rail());
    expect(rail().dataset['open']).toBe('true');

    // Pinned is a toggle, so unpinning hands the rail back to hover.
    fireEvent.click(screen.getByRole('button', { name: 'Unpin sidebar' }));
    expect(rail().dataset['open']).toBe('false');
  });

  it('announces the pin state rather than only painting it', () => {
    renderRail();
    fireEvent.mouseEnter(rail());
    const pin = screen.getByRole('button', { name: 'Keep sidebar open' });
    // FE-HIGH-159: the mockup's pin switched className on `pinned` and declared
    // nothing, so a screen reader heard "button" in both states.
    expect(pin.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(pin);
    expect(screen.getByRole('button', { name: 'Unpin sidebar' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
  });

  it('opens a group on click and starts open when one of its children is active', () => {
    const onNavigate = vi.fn();
    const { unmount } = renderRail({ onNavigate });
    fireEvent.mouseEnter(rail());

    const group = screen.getByRole('button', { name: /Farm/ });
    expect(group.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('button', { name: 'Ponds' })).toBeNull();

    fireEvent.click(group);
    expect(group.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Ponds' }));
    expect(onNavigate).toHaveBeenCalledWith('/farm/ponds');

    unmount();
    renderRail({ activePath: '/farm/batches' });
    fireEvent.mouseEnter(rail());
    expect(screen.getByRole('button', { name: /Farm/ }).getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('button', { name: 'Batches' }).getAttribute('aria-current')).toBe(
      'page',
    );
  });

  it('does not render an item the user has no role for', () => {
    renderRail();
    fireEvent.mouseEnter(rail());
    expect(screen.queryByRole('button', { name: 'Billing' })).toBeNull();

    cleanup();
    renderRail({ userRoles: ['TENANT_ADMIN'] });
    fireEvent.mouseEnter(rail());
    expect(screen.getByRole('button', { name: 'Billing' })).toBeTruthy();
  });

  it('draws its icons from the shared registry, not from pasted path data', () => {
    const { container } = renderRail();
    fireEvent.mouseEnter(rail());
    const icons = container.querySelectorAll('svg.sd-rail-icon');
    expect(icons.length).toBeGreaterThan(0);
    // FE-MEDIUM-082: lucide renders `class="lucide …"`. A hand-transcribed
    // registry would not, which is the difference the inlineIconSvg ratchet
    // counts — so this fails the moment the mockup's ICON_PATHS comes back.
    for (const icon of icons) {
      expect(icon.getAttribute('class')).toContain('lucide');
    }
  });

  it('takes every visible string from the locale, including the status footer', () => {
    const { container } = renderRail();
    // Collapsed, the footer is a dot only; the caption appears with the drawer.
    expect(screen.queryByText('Live')).toBeNull();
    fireEvent.mouseEnter(rail());
    expect(container.querySelector('.sd-rail-status-text')?.textContent).toBe('Live');
    // A caller-supplied caption still wins — it is tenant data, not chrome.
    cleanup();
    renderRail({ statusText: '3 sites online' });
    fireEvent.mouseEnter(rail());
    expect(screen.getByText('3 sites online')).toBeTruthy();
  });
});
