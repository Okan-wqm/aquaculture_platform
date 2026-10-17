/**
 * IndustrialRail — the tenant console rail (design handoff §7.2, §8).
 *
 * Pins the rail's contract: the active workspace's accordion (area → group →
 * page → level-3 tabs), rows as real links (plain click navigates, a modified
 * click is left to the browser, hover preloads), badges from data only, the
 * planned tag, the user-controlled collapse with its automatic default below
 * 1100 px, the data-backed device band, the workspace menu trigger, and the
 * phone overlay it shares with Sidebar through navShared.ts.
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { IndustrialRail, type IndustrialRailProps } from '../IndustrialRail';

import { AQUA, GH, installMatchMedia, WORKSPACES } from './railFixtures';

let media: ReturnType<typeof installMatchMedia>;

beforeEach(() => {
  media = installMatchMedia();
});
afterEach(cleanup);

function renderRail(overrides: Partial<IndustrialRailProps> = {}): {
  props: IndustrialRailProps;
  rerender: (next: Partial<IndustrialRailProps>) => void;
} {
  const props: IndustrialRailProps = {
    workspaces: WORKSPACES,
    activeWorkspaceId: 'aqua',
    onWorkspaceSelect: vi.fn(),
    active: { areaId: 'aq-ops', pageId: 'feeding', tabId: 'records' },
    badgeCounts: { alarmsUnack: 5, leavePending: 2 },
    onNavigate: vi.fn(),
    onItemHover: vi.fn(),
    tenantName: 'Aegean Aqua',
    logoSrc: '/logo4-mark.png',
    collapsed: false,
    onCollapsedChange: vi.fn(),
    devices: { status: 'ready', online: 11, total: 12 },
    mobileOpen: false,
    onMobileOpenChange: vi.fn(),
    ...overrides,
  };
  const view = render(<IndustrialRail {...props} />);
  return {
    props,
    rerender: (next) => view.rerender(<IndustrialRail {...props} {...next} />),
  };
}

/** The rail: the navigation landmark in the column, a modal dialog as the phone overlay. */
function rail(): HTMLElement {
  return (
    screen.queryByRole('dialog', { name: 'Main navigation' }) ??
    screen.getByRole('navigation', { name: 'Main navigation' })
  );
}

function areaButton(name: string): HTMLElement {
  return within(rail()).getByRole('button', { name: new RegExp(`^${name}`) });
}

describe('IndustrialRail — expanded accordion', () => {
  it('names the rail, shows the tenant and the active workspace, and lists only its areas', () => {
    renderRail();
    expect(within(rail()).getByText('Aegean Aqua')).toBeInTheDocument();
    expect(within(rail()).getByText('Production')).toBeInTheDocument();
    // One landmark around header, areas and device band; the header names the workspace.
    expect(screen.getByRole('navigation', { name: 'Main navigation' })).toBe(rail());
    expect(within(rail()).queryByRole('navigation')).toBeNull();
    expect(screen.queryByRole('complementary')).toBeNull();
    expect(areaButton('Overview')).toBeInTheDocument();
    expect(areaButton('Operations')).toBeInTheDocument();
    expect(within(rail()).queryByText('Greenhouse operations')).not.toBeInTheDocument();
    expect(rail()).toHaveAttribute('data-collapsed', 'false');
  });

  it('opens the area holding the current page and marks that page aria-current="page"', () => {
    renderRail();
    expect(areaButton('Operations')).toHaveAttribute('aria-expanded', 'true');
    expect(areaButton('Overview')).toHaveAttribute('aria-expanded', 'false');
    const feeding = within(rail()).getByRole('link', { name: 'Feeding' });
    expect(feeding).toHaveAttribute('aria-current', 'page');
    expect(feeding).toHaveAttribute('href', '/sites/feeding');
    expect(within(rail()).getByRole('link', { name: 'Tanks & ponds' })).not.toHaveAttribute(
      'aria-current',
    );
    // A titled group is announced by its title.
    expect(within(rail()).getByRole('group', { name: 'Live' })).toBeInTheDocument();
    // The open area controls its body.
    const controls = areaButton('Operations').getAttribute('aria-controls');
    expect(controls).toBeTruthy();
    expect(document.getElementById(controls ?? '')).toContainElement(feeding);
  });

  it('shows the level-3 tabs of the active page only, the current tab marked', () => {
    renderRail();
    const records = within(rail()).getByRole('link', { name: 'Records' });
    expect(records).toHaveAttribute('href', '/sites/feeding?tab=records');
    expect(records).toHaveAttribute('aria-current', 'true');
    expect(within(rail()).getByRole('link', { name: 'Meal board' })).not.toHaveAttribute(
      'aria-current',
    );
  });

  it('toggles areas: a closed one opens, the active one closes, several may be open at once', () => {
    renderRail();
    fireEvent.click(areaButton('Overview'));
    expect(areaButton('Overview')).toHaveAttribute('aria-expanded', 'true');
    expect(within(rail()).getByRole('link', { name: 'Dashboard' })).toBeInTheDocument();
    expect(areaButton('Operations')).toHaveAttribute('aria-expanded', 'true');

    fireEvent.click(areaButton('Operations'));
    expect(areaButton('Operations')).toHaveAttribute('aria-expanded', 'false');
    expect(within(rail()).queryByRole('link', { name: 'Feeding' })).not.toBeInTheDocument();
  });

  it('forgets the opened and closed areas when the workspace changes', () => {
    const { rerender } = renderRail();
    fireEvent.click(areaButton('Overview'));
    expect(areaButton('Overview')).toHaveAttribute('aria-expanded', 'true');

    rerender({ activeWorkspaceId: 'gh', active: undefined });
    expect(areaButton('Greenhouse operations')).toHaveAttribute('aria-expanded', 'false');
    rerender({ activeWorkspaceId: 'aqua', active: undefined });
    expect(areaButton('Overview')).toHaveAttribute('aria-expanded', 'false');
  });

  it('tags a planned page', () => {
    renderRail({ active: { areaId: 'aq-team', pageId: 'team-leave' } });
    const today = within(rail()).getByRole('link', { name: /Today/ });
    expect(within(today).getByText('Planned')).toBeInTheDocument();
  });
});

describe('IndustrialRail — rows are links', () => {
  it('navigates on a plain click and keeps the browser from following the href', () => {
    const { props } = renderRail();
    const tanks = within(rail()).getByRole('link', { name: 'Tanks & ponds' });
    const followed = fireEvent.click(tanks);
    expect(followed).toBe(false);
    expect(props.onNavigate).toHaveBeenCalledWith('/sites/tanks');
  });

  it('leaves a modified click (new tab, new window) to the browser', () => {
    const { props } = renderRail();
    const tanks = within(rail()).getByRole('link', { name: 'Tanks & ponds' });
    // Seen at the document, after the rail's handler: whether the rail let the
    // browser have it. The listener then stops jsdom, which cannot navigate.
    const leftToBrowser: boolean[] = [];
    const observe = (event: MouseEvent): void => {
      leftToBrowser.push(!event.defaultPrevented);
      event.preventDefault();
    };
    document.addEventListener('click', observe);
    fireEvent.click(tanks, { ctrlKey: true });
    fireEvent.click(tanks, { metaKey: true });
    fireEvent.click(tanks, { shiftKey: true });
    document.removeEventListener('click', observe);
    expect(leftToBrowser).toEqual([true, true, true]);
    expect(props.onNavigate).not.toHaveBeenCalled();
  });

  it('reports hover intent with the destination, for route preloading', () => {
    const { props } = renderRail();
    fireEvent.mouseEnter(within(rail()).getByRole('link', { name: 'Tasks' }));
    expect(props.onItemHover).toHaveBeenCalledWith('/sites/tasks');
    fireEvent.mouseEnter(within(rail()).getByRole('link', { name: 'Records' }));
    expect(props.onItemHover).toHaveBeenCalledWith('/sites/feeding?tab=records');
  });

  it('navigates from a level-3 tab', () => {
    const { props } = renderRail();
    fireEvent.click(within(rail()).getByRole('link', { name: 'Meal board' }));
    expect(props.onNavigate).toHaveBeenCalledWith('/sites/feeding?tab=board');
  });
});

describe('IndustrialRail — badges come from data only', () => {
  it('shows a page badge with its count, and the area sum only while the area is closed', () => {
    renderRail();
    // Overview is closed: its badge is the sum of its pages' counts (alarms 5).
    expect(areaButton('Overview')).toHaveTextContent('5');
    fireEvent.click(areaButton('Overview'));
    expect(areaButton('Overview')).not.toHaveTextContent('5');
    expect(within(rail()).getByRole('link', { name: /Alarms/ })).toHaveTextContent('5');
  });

  it('shows no badge for a zero or missing count', () => {
    renderRail({ badgeCounts: { alarmsUnack: 0 } });
    expect(areaButton('Overview')).not.toHaveTextContent(/\d/);
    expect(areaButton('Team')).not.toHaveTextContent(/\d/);
  });
});

describe('IndustrialRail — collapse', () => {
  it('collapses on the user’s request', () => {
    const { props } = renderRail();
    fireEvent.click(within(rail()).getByRole('button', { name: 'Collapse sidebar' }));
    expect(props.onCollapsedChange).toHaveBeenCalledWith(true);
  });

  it('shows one icon tile per area when collapsed, named and titled by the area', () => {
    renderRail({ collapsed: true });
    expect(rail()).toHaveAttribute('data-collapsed', 'true');
    expect(within(rail()).queryByRole('link')).not.toBeInTheDocument();
    const tile = within(rail()).getByRole('button', { name: /^Operations/ });
    expect(tile).toHaveAttribute('title', 'Operations');
    expect(tile).toHaveAttribute('aria-current', 'true');
    expect(within(tile).getByText('Operations')).toHaveClass('sr-only');
    // The collapsed tile keeps its badge.
    expect(within(rail()).getByRole('button', { name: /^Overview/ })).toHaveTextContent('5');
  });

  it('expands from a tile and opens that tile’s area', () => {
    const { props, rerender } = renderRail({ collapsed: true });
    fireEvent.click(within(rail()).getByRole('button', { name: /^Team/ }));
    expect(props.onCollapsedChange).toHaveBeenCalledWith(false);
    rerender({ collapsed: false });
    expect(areaButton('Team')).toHaveAttribute('aria-expanded', 'true');
    expect(areaButton('Team')).toHaveFocus();
  });

  it('expands from the expand button', () => {
    const { props } = renderRail({ collapsed: true });
    fireEvent.click(within(rail()).getByRole('button', { name: 'Expand sidebar' }));
    expect(props.onCollapsedChange).toHaveBeenCalledWith(false);
  });

  it('with no preference, follows the window: collapsed below 1100 px, expanded above', () => {
    media.setNarrow(true);
    renderRail({ collapsed: null });
    expect(rail()).toHaveAttribute('data-collapsed', 'true');
    act(() => media.setNarrow(false));
    expect(rail()).toHaveAttribute('data-collapsed', 'false');
  });

  it('an explicit preference wins over the window', () => {
    media.setNarrow(true);
    renderRail({ collapsed: false });
    expect(rail()).toHaveAttribute('data-collapsed', 'false');
  });
});

describe('IndustrialRail — device band', () => {
  it('reads the live device count when it is ready', () => {
    renderRail();
    expect(within(rail()).getByText('11 of 12 devices online')).toBeInTheDocument();
  });

  it('shows the short form when collapsed, with the full sentence for assistive technology', () => {
    renderRail({ collapsed: true });
    expect(within(rail()).getByText('11/12')).toBeInTheDocument();
    expect(within(rail()).getByText('11 of 12 devices online')).toHaveClass('sr-only');
  });

  it.each(['loading', 'error', 'unavailable'] as const)('is hidden while %s', (status) => {
    renderRail({ devices: { status, online: null, total: null } });
    expect(within(rail()).queryByText(/devices? online/)).not.toBeInTheDocument();
  });

  it('is hidden with no device source', () => {
    renderRail({ devices: undefined });
    expect(within(rail()).queryByText(/devices? online/)).not.toBeInTheDocument();
  });
});

describe('IndustrialRail — workspace menu', () => {
  function trigger(): HTMLElement {
    return within(rail()).getByRole('button', { name: /switch module/ });
  }

  it('opens the module menu from the logo and workspace name, and switches workspace', () => {
    const { props } = renderRail();
    expect(trigger()).toHaveAttribute('aria-haspopup', 'dialog');
    expect(trigger()).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(trigger());
    expect(trigger()).toHaveAttribute('aria-expanded', 'true');
    const menu = screen.getByRole('dialog', { name: 'Module' });
    expect(within(menu).getByRole('button', { name: /Production/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    fireEvent.click(within(menu).getByRole('button', { name: /Greenhouse/ }));
    expect(props.onWorkspaceSelect).toHaveBeenCalledWith('gh');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('names the tenant in the trigger when the session names one', () => {
    renderRail();
    expect(trigger()).toHaveAccessibleName('Aegean Aqua, Production — switch module');
  });

  it('draws no tenant line and leaves the tenant out of the trigger while none is named', () => {
    renderRail({ tenantName: null });
    expect(trigger()).toHaveAccessibleName('Production — switch module');
    // The names block holds the workspace line alone: no empty tenant line above it.
    expect(trigger()).toHaveTextContent(/^Production$/);
    const emptyLines = Array.from(trigger().querySelectorAll('span')).filter(
      (span) => span.childElementCount === 0 && span.textContent === '',
    );
    expect(emptyLines).toHaveLength(0);
  });

  it('keeps the trigger in the collapsed rail', () => {
    renderRail({ collapsed: true });
    fireEvent.click(trigger());
    expect(screen.getByRole('dialog', { name: 'Module' })).toBeInTheDocument();
  });

  it('closes on Escape and returns focus to the trigger', () => {
    renderRail();
    fireEvent.click(trigger());
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger()).toHaveFocus();
  });

  it('passes each workspace’s alarm slot through', () => {
    const renderWorkspaceAlarms = vi.fn((id: string) => <span>alarms of {id}</span>);
    renderRail({ renderWorkspaceAlarms });
    fireEvent.click(trigger());
    expect(screen.getByText('alarms of gh')).toBeInTheDocument();
    expect(renderWorkspaceAlarms).toHaveBeenCalledWith('aqua');
  });
});

describe('IndustrialRail — phone overlay', () => {
  // It traps Tab, locks the page's scroll and covers it with a scrim: a
  // screen reader has to be told a modal opened.
  it('is exposed as a modal dialog named "Main navigation" while open', () => {
    media.setDesktop(false);
    renderRail({ mobileOpen: true, id: 'main-navigation' });
    const overlay = screen.getByRole('dialog', { name: 'Main navigation' });
    expect(overlay).toHaveAttribute('aria-modal', 'true');
    expect(overlay).toHaveAttribute('id', 'main-navigation');
    expect(screen.queryByRole('navigation', { name: 'Main navigation' })).toBeNull();
  });

  it('draws a backdrop that closes the overlay, and closes it after navigating', () => {
    media.setDesktop(false);
    const { props } = renderRail({ mobileOpen: true, collapsed: true });
    // The overlay always shows labels, whatever the desktop preference.
    expect(rail()).toHaveAttribute('data-collapsed', 'false');
    expect(within(rail()).queryByRole('button', { name: 'Collapse sidebar' })).toBeNull();
    fireEvent.click(within(rail()).getByRole('link', { name: 'Tanks & ponds' }));
    expect(props.onNavigate).toHaveBeenCalledWith('/sites/tanks');
    expect(props.onMobileOpenChange).toHaveBeenCalledWith(false);
  });

  it('closes from its backdrop and its close button', () => {
    media.setDesktop(false);
    const { props } = renderRail({ mobileOpen: true });
    fireEvent.click(screen.getByTestId('sidebar-backdrop'));
    expect(props.onMobileOpenChange).toHaveBeenCalledWith(false);
    fireEvent.click(within(rail()).getByRole('button', { name: 'Close navigation' }));
    expect(props.onMobileOpenChange).toHaveBeenCalledTimes(2);
  });

  it('renders nothing of a workspace it was not given', () => {
    renderRail({ workspaces: [GH], activeWorkspaceId: 'aqua', active: undefined });
    expect(within(rail()).queryAllByRole('link')).toHaveLength(0);
    expect(within(rail()).queryByText(AQUA.label)).not.toBeInTheDocument();
  });
});
