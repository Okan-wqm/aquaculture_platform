/**
 * The board's top bar makes four claims about the farm — how many units and
 * sites are in scope, how many alarms are unacknowledged, what this device still
 * owes the farm, and the time. Three of them come from queries that fail, and a
 * cabin display asserting "No alarms" while it cannot reach the alert engine is
 * the single most expensive lie this app can tell. These tests hold that line,
 * plus the clock's one-interval-cleared-on-unmount contract, because a shell
 * that leaks an interval leaks it every time the tablet is rotated.
 */
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TabletLayout } from '../TabletLayout';

const mockUseTanks = vi.fn();
vi.mock('@/hooks/useTanks', () => ({ useTanks: (): unknown => mockUseTanks() }));

const mockUseAlerts = vi.fn();
vi.mock('@/hooks/useAlerts', () => ({ useAlerts: (): unknown => mockUseAlerts() }));

const mockUseOfflineQueue = vi.fn();
vi.mock('@/hooks/useOfflineQueue', () => ({
  useOfflineQueue: (): unknown => mockUseOfflineQueue(),
}));

vi.mock('@/utils/feature-access', () => ({
  useFeatureAccess: (): unknown => ({ canReach: () => true }),
}));

vi.mock('@/hooks/useAuth', () => ({ useAuth: (): unknown => ({ user: { name: 'Ola Nordvik' } }) }));

// The critical-alarm banner is exercised by its own tests and drags the push
// lane in with it; the board only has to render it.
vi.mock('@/components/CriticalAlertBanner', () => ({ CriticalAlertBanner: (): null => null }));

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: (): unknown => mockNavigate };
});

const CLOCK = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

function unit(id: string, siteId: string | null): unknown {
  return {
    id,
    name: id,
    code: id,
    volume: 0,
    status: 'ACTIVE',
    siteId,
    currentQuantity: 0,
    currentBiomass: 0,
    maxBiomass: 0,
    batchMetrics: null,
  };
}

function renderBoard(): void {
  render(
    <MemoryRouter initialEntries={['/board']}>
      <TabletLayout>
        <span data-testid="content">panes</span>
      </TabletLayout>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockUseTanks.mockReturnValue({ data: [], isLoading: false, isError: false });
  mockUseAlerts.mockReturnValue({ unacknowledgedCount: 0, isLoading: false, error: null });
  mockUseOfflineQueue.mockReturnValue({ pendingCount: 0, isOnline: true, isSyncing: false });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('TabletLayout — the board top bar', () => {
  it('states the scope from the unit list the phone already loads', () => {
    mockUseTanks.mockReturnValue({
      data: [unit('U-01', 'site-a'), unit('U-02', 'site-a'), unit('U-03', 'site-b')],
      isLoading: false,
      isError: false,
    });
    renderBoard();

    expect(screen.getByText('All 2 sites · 3 units')).toBeTruthy();
  });

  it('keeps an empty tenant distinct from an unreachable one', () => {
    // The query succeeded and returned nothing. That is a different fact from
    // the failure below, and the two must not read alike.
    renderBoard();
    expect(screen.getByText('No units in this tenant')).toBeTruthy();
  });

  it('says the unit list is unavailable rather than reporting zero units', () => {
    mockUseTanks.mockReturnValue({ data: undefined, isLoading: false, isError: true });
    renderBoard();

    expect(screen.getByText(/Unit list unavailable/)).toBeTruthy();
    expect(screen.queryByText(/0 units/)).toBeNull();
  });

  it('says alarms are unavailable rather than "No alarms" when the fetch failed', () => {
    mockUseAlerts.mockReturnValue({
      unacknowledgedCount: 0,
      isLoading: false,
      error: 'Network request failed',
    });
    renderBoard();

    expect(screen.getByText('Alarms unavailable')).toBeTruthy();
    expect(screen.queryByText('No alarms')).toBeNull();
  });

  it('shows the unacknowledged alarm count and opens the alarm list', () => {
    mockUseAlerts.mockReturnValue({ unacknowledgedCount: 3, isLoading: false, error: null });
    renderBoard();

    fireEvent.click(screen.getByRole('button', { name: /3 unacknowledged alarms/ }));
    expect(mockNavigate).toHaveBeenCalledWith('/alerts');
  });

  it('reports what the device still owes the farm while offline', () => {
    mockUseOfflineQueue.mockReturnValue({ pendingCount: 2, isOnline: false, isSyncing: false });
    renderBoard();

    expect(screen.getByText(/Offline · 2 queued/)).toBeTruthy();
  });

  it('switches views through the three-way control', () => {
    renderBoard();

    // The board's own views, not the phone's screens. The `/board` prefix is
    // load-bearing: AppShell redirects everything under it to Today below the
    // board threshold, so routing the switcher here is what makes a two-column
    // report and a two-pane chat unreachable on a phone WITHOUT a second
    // viewport check existing anywhere. Pointing these at /reports and /messages
    // would silently hand a 390px screen a multi-column layout.
    fireEvent.click(screen.getByRole('button', { name: 'Reports' }));
    expect(mockNavigate).toHaveBeenCalledWith('/board/reports');

    fireEvent.click(screen.getByRole('button', { name: 'Chat' }));
    expect(mockNavigate).toHaveBeenCalledWith('/board/chat');
  });

  it('keeps the Reports segment lit on the phone screen its rows link out to', () => {
    // A manager opening a filing from the board lands on /reports/:draftId — the
    // handheld's review screen, rendered inside this shell. The switcher must
    // still say "Reports" there; three unlit segments would tell them they had
    // left the view they are plainly still in.
    render(
      <MemoryRouter initialEntries={['/reports/draft-7']}>
        <TabletLayout>
          <span>review</span>
        </TabletLayout>
      </MemoryRouter>,
    );

    expect(screen.getByRole('button', { name: 'Reports' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(screen.getByRole('button', { name: 'Board' }).getAttribute('aria-pressed')).toBe(
      'false',
    );
  });

  it('ticks the clock on ONE interval and clears it on unmount', () => {
    vi.useFakeTimers();
    const start = new Date('2026-08-07T09:14:05');
    vi.setSystemTime(start);

    render(
      <MemoryRouter initialEntries={['/board']}>
        <TabletLayout>
          <span>panes</span>
        </TabletLayout>
      </MemoryRouter>,
    );

    expect(screen.getByText(CLOCK.format(start))).toBeTruthy();
    expect(vi.getTimerCount(), 'the board must run exactly one clock interval').toBe(1);

    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    const later = new Date(start.getTime() + 60_000);
    expect(screen.getByText(CLOCK.format(later))).toBeTruthy();

    cleanup();
    expect(vi.getTimerCount(), 'the clock interval outlived the shell').toBe(0);
  });

  it('renders its children in the content area', () => {
    renderBoard();
    expect(screen.getByTestId('content')).toBeTruthy();
  });
});
