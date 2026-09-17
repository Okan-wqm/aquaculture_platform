/**
 * The Reports board view makes claims about a farm and about a regulator's
 * deadlines, from two queries that fail. What is worth pinning is therefore not
 * the layout but the honesty:
 *
 *   • a failed inventory fetch must never render "0 units past the watch line" —
 *     an all-clear about stocking density that nobody checked;
 *   • a failed deadline fetch must never render "No reports due" — the most
 *     expensive version of that same lie, since a missed filing is a fine;
 *   • an EMPTY result must stay visibly distinct from a failed one;
 *   • the submissions column is MODULE_MANAGER-gated exactly as on the phone;
 *   • no trend chart is drawn, and the screen says why.
 */
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ReportsBoardPage } from '../ReportsBoardPage';

const mockUseTanks = vi.fn();
vi.mock('@/hooks/useTanks', () => ({ useTanks: (): unknown => mockUseTanks() }));

const mockUseReportDeadlines = vi.fn();
vi.mock('@/hooks/useReportDeadlines', () => ({
  useReportDeadlines: (): unknown => mockUseReportDeadlines(),
}));

const mockIsOnline = vi.fn();
vi.mock('@/hooks/useNetworkStatus', () => ({ useNetworkStatus: (): unknown => mockIsOnline() }));

const mockCanReach = vi.fn<(feature: string) => boolean>();
vi.mock('@/utils/feature-access', () => ({
  useFeatureAccess: (): unknown => ({
    canReach: (feature: string): boolean => mockCanReach(feature),
  }),
}));

/** A stocked unit at `capacity` percent of consent. */
function unit(id: string, capacity: number | null, overCapacity = false): unknown {
  return {
    id,
    name: `Pen ${id}`,
    code: id,
    volume: 1000,
    status: 'ACTIVE',
    siteId: 'site-a',
    currentQuantity: 10_000,
    currentBiomass: 25_000,
    maxBiomass: 40_000,
    batchMetrics: {
      batchId: `batch-${id}`,
      capacityUsedPercent: capacity,
      isOverCapacity: overCapacity,
      density: 12.5,
    },
  };
}

function deadline(id: string, overdue: boolean): unknown {
  return {
    id,
    reportType: 'SEA_LICE',
    siteId: 'site-a',
    periodYear: 2026,
    periodWeek: 31,
    periodMonth: null,
    status: 'DRAFT',
    dueAt: '2026-08-09',
    overdue,
    daysUntilDue: overdue ? -3 : 5,
  };
}

function renderView(): void {
  render(
    <MemoryRouter initialEntries={['/board/reports']}>
      <ReportsBoardPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockUseTanks.mockReturnValue({ data: [unit('U-01', 40)], isLoading: false, isError: false });
  mockUseReportDeadlines.mockReturnValue({ data: [], isLoading: false, isError: false });
  mockIsOnline.mockReturnValue(true);
  mockCanReach.mockReturnValue(true);
});

afterEach(cleanup);

describe('ReportsBoardPage — the board Reports view', () => {
  it('lays the farm summary and the submissions side by side', () => {
    renderView();
    expect(screen.getByRole('region', { name: 'Farm summary' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Regulatory submissions' })).toBeTruthy();
  });

  it('states the biomass-weighted average weight and the standing biomass', () => {
    // Two pens: 10 000 fish / 25 000 kg each → 50 000 kg over 20 000 fish
    // = 2500 g per fish, and 50.0 t standing.
    mockUseTanks.mockReturnValue({
      data: [unit('U-01', 40), unit('U-02', 55)],
      isLoading: false,
      isError: false,
    });
    renderView();

    expect(screen.getByText('2500')).toBeTruthy();
    expect(screen.getByText('50.0')).toBeTruthy();
    expect(screen.getByText(/20,000 fish/)).toBeTruthy();
  });

  it('says the farm summary is unavailable rather than reporting zeroes', () => {
    mockUseTanks.mockReturnValue({ data: undefined, isLoading: false, isError: true });
    renderView();

    expect(screen.getByText(/Could not load the farm summary/)).toBeTruthy();
    // The three figures a failed fetch must not invent.
    expect(screen.queryByText('Average weight')).toBeNull();
    expect(screen.queryByText('Standing biomass')).toBeNull();
    expect(screen.queryByText('Units past the watch line')).toBeNull();
  });

  it('keeps a stale success out of the summary when the refetch failed', () => {
    // TanStack hands back the LAST GOOD data alongside isError. Rendering it
    // would put yesterday's figures on a wall display under today's date.
    mockUseTanks.mockReturnValue({
      data: [unit('U-01', 95, true)],
      isLoading: false,
      isError: true,
    });
    renderView();

    expect(screen.getByText(/Could not load the farm summary/)).toBeTruthy();
    expect(screen.queryByText('Units over consent')).toBeNull();
    expect(screen.queryByText('Closest to consent')).toBeNull();
  });

  it('keeps an unstocked farm distinct from an unreachable one', () => {
    mockUseTanks.mockReturnValue({ data: [], isLoading: false, isError: false });
    renderView();

    expect(screen.getByText('No units')).toBeTruthy();
    expect(screen.queryByText(/Could not load/)).toBeNull();
  });

  it('flags units over consent from the farm service, not from a local threshold', () => {
    // 60% used — below the 70% advisory line — but the SERVICE says over consent
    // (it fires on biomass and status axes too). The service wins.
    mockUseTanks.mockReturnValue({
      data: [unit('U-01', 60, true)],
      isLoading: false,
      isError: false,
    });
    renderView();

    expect(screen.getByText('Units over consent')).toBeTruthy();
  });

  it('shows an em dash, not 0%, for a unit with no configured consent capacity', () => {
    mockUseTanks.mockReturnValue({ data: [unit('U-01', null)], isLoading: false, isError: false });
    renderView();

    const row = screen.getByRole('button', { name: /Pen U-01/ });
    expect(row.textContent).toContain('—%');
    expect(row.textContent).not.toContain('0%');
  });

  it('says deadlines are unavailable rather than "No reports due"', () => {
    mockUseReportDeadlines.mockReturnValue({ data: undefined, isLoading: false, isError: true });
    renderView();

    expect(screen.getByText(/Could not load deadlines/)).toBeTruthy();
    expect(screen.queryByText('No reports due')).toBeNull();
  });

  it('explains the offline case instead of spinning on a query it never runs', () => {
    // useReportDeadlines disables itself offline, so a Loadable would sit at
    // `loading` forever. A permanent skeleton is not an explanation.
    mockIsOnline.mockReturnValue(false);
    renderView();

    expect(screen.getByText(/Submissions need a connection/)).toBeTruthy();
    expect(screen.queryByTestId('skeleton')).toBeNull();
  });

  it('lists the drafts a manager may act on', () => {
    mockUseReportDeadlines.mockReturnValue({
      data: [deadline('draft-late', true), deadline('draft-ok', false)],
      isLoading: false,
      isError: false,
    });
    renderView();

    expect(screen.getAllByText('Sea Lice (weekly)').length).toBe(2);
    expect(screen.getByText('Overdue')).toBeTruthy();
  });

  it('hides the submissions column from a role the phone hides it from', () => {
    // canReach('reports') is the entitlement AND the MODULE_MANAGER floor. A
    // field worker gets the farm summary and no submissions column — the same
    // thing the handheld gives them.
    mockCanReach.mockImplementation((feature: string) => feature !== 'reports');
    renderView();

    expect(screen.getByRole('region', { name: 'Farm summary' })).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Regulatory submissions' })).toBeNull();
  });

  it('says why there are no trend charts instead of drawing one', () => {
    renderView();
    expect(screen.getByText(/no history query/)).toBeTruthy();
  });
});
