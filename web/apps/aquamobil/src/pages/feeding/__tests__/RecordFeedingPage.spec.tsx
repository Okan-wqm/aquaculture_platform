/**
 * RecordFeedingPage specs — Faz 6 öğün cutover'ı.
 *
 * Kapsam:
 * - FE-MEDIUM-054 davranışı yeni tipli kaynakta korunur: başarılı online
 *   fetch şifreli tenant-scoped cache'e yazar; çevrimdışı açılışta son
 *   eşitlenen plan + dürüst bant render edilir.
 * - Öğün akışı: açık öğüne dokun → kalan miktar ön-dolu → kaydet →
 *   `recordMealFeeding` payload'ı (mealId/pourKg/finalize/feedingMethod)
 *   kuyruğa gider (zarf enqueue'da damgalanır — burada payload SAF domain'dir).
 * - Enum kasası: tel değerleri AD'dır ('SCHEDULED', 'FED', ...).
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mock state
// ---------------------------------------------------------------------------
const h = vi.hoisted(() => ({
  isOnline: true,
  graphqlRequest: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  cacheData: vi.fn<(...args: unknown[]) => Promise<void>>(),
  getCachedData: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  addToQueue: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
}));

vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn(),
  useParams: () => ({}),
}));

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ accessToken: 'token', tenantId: 'tenant-1', isAuthenticated: true }),
}));

vi.mock('@/hooks/useOfflineQueue', () => ({
  useOfflineQueue: () => ({ addToQueue: h.addToQueue, isOnline: h.isOnline }),
}));

vi.mock('@/services/authenticated-fetch', () => ({
  graphqlRequest: (...args: unknown[]) => h.graphqlRequest(...args),
}));

vi.mock('@/components/QueuedStatusBadge', () => ({
  QueuedStatusBadge: ({ operationId }: { operationId: string }) =>
    createElement('div', { 'data-testid': 'queued-status-badge' }, operationId),
}));

vi.mock('@/pwa/offline-queue', () => ({
  cacheData: (...args: unknown[]) => h.cacheData(...args),
  getCachedData: (...args: unknown[]) => h.getCachedData(...args),
}));

import { RecordFeedingPage } from '../RecordFeedingPage';

const plan = {
  id: 'plan-1',
  unitId: 'unit-1',
  unitName: 'Tank 1',
  unitCode: 'T1',
  planDate: '2026-07-16',
  status: 'PLANNED',
  plannedTotalKg: 12,
  unplannedActualKg: 0,
  mealsPlanned: 2,
  avgWeightG: 250,
  fishCount: 4000,
  biomassKg: 1000,
  waterTempC: 14.5,
  temperatureSource: 'sensor',
  usingDefaultTemperature: false,
  feedId: 'feed-1',
  feedCode: 'PEL-3MM',
  feedName: 'Pellet 3mm',
  effectiveRatePercent: 1.2,
  expectedFcr: 1.15,
  meals: [
    {
      id: 'meal-1',
      mealIndex: 0,
      scheduledAt: '2026-07-16T08:00:00.000Z',
      percentOfDaily: 50,
      plannedKg: 6,
      status: 'SCHEDULED',
      actualKg: 0,
      varianceKg: null,
      variancePercent: null,
      feedId: 'feed-1',
    },
    {
      id: 'meal-2',
      mealIndex: 1,
      scheduledAt: '2026-07-16T16:00:00.000Z',
      percentOfDaily: 50,
      plannedKg: 6,
      status: 'FED',
      actualKg: 6,
      varianceKg: 0,
      variancePercent: 0,
      feedId: 'feed-1',
    },
  ],
};

function wrapper(client: QueryClient): ({ children }: { children: ReactNode }) => ReactNode {
  function Wrapper({ children }: { children: ReactNode }): ReactNode {
    return createElement(QueryClientProvider, { client }, children);
  }
  return Wrapper;
}

async function selectUnit(): Promise<void> {
  // Planlar yüklenmeden select'te 'unit-1' opsiyonu yoktur — önce onu bekle
  // (erken change value'yu '' bırakır ve öğün listesi hiç açılmaz).
  await screen.findByRole('option', { name: /Tank 1/ });
  const select = screen.getByRole('combobox');
  fireEvent.change(select, { target: { value: 'unit-1' } });
}

describe('RecordFeedingPage — öğün cutover (Faz 6)', () => {
  let client: QueryClient;

  beforeEach(() => {
    vi.clearAllMocks();
    h.isOnline = true;
    h.getCachedData.mockResolvedValue(null);
    h.addToQueue.mockResolvedValue({ status: 'queued', id: 'op-1' });
    client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
  });

  afterEach(() => {
    cleanup();
    client.clear();
  });

  it('write-throughs the fetched day plans to the encrypted cache (FE-MEDIUM-054)', async () => {
    h.graphqlRequest.mockResolvedValue({ feedingDayPlans: [plan] });

    render(createElement(RecordFeedingPage), { wrapper: wrapper(client) });

    await waitFor(() => expect(h.cacheData).toHaveBeenCalled());
    const [tenantId, key, value] = h.cacheData.mock.calls[0] ?? [];
    expect(tenantId).toBe('tenant-1');
    expect(String(key)).toMatch(/^feedingDayPlans_/);
    expect(value).toEqual([plan]);
  });

  it('renders the last-synced plans + offline banner when offline with a cached seed', async () => {
    h.isOnline = false;
    h.getCachedData.mockResolvedValue([plan]);
    h.graphqlRequest.mockRejectedValue(new Error('offline'));

    render(createElement(RecordFeedingPage), { wrapper: wrapper(client) });

    await waitFor(() => expect(screen.getByText(/last-synced plan/i)).toBeTruthy());
  });

  it('queues a recordMealFeeding pour for an open meal with the remaining amount pre-filled', async () => {
    h.graphqlRequest.mockResolvedValue({ feedingDayPlans: [plan] });

    render(createElement(RecordFeedingPage), { wrapper: wrapper(client) });
    await selectUnit();

    // Açık öğün (SCHEDULED) dokunulabilir; FED öğünün butonu disabled'dır.
    const mealButtons = await screen.findAllByRole('button');
    const openMeal = mealButtons.find((b) => b.textContent?.includes('08:'));
    const fedMeal = mealButtons.find((b) => b.textContent?.includes('16:'));
    expect(openMeal).toBeTruthy();
    expect(fedMeal).toHaveProperty('disabled', true);

    fireEvent.click(openMeal as HTMLElement);

    // Kalan plan miktarı (6.00) ön-dolu gelir.
    const amount = await screen.findByRole<HTMLInputElement>('spinbutton');
    expect(amount.value).toBe('6.00');

    // "6.00 kg" metni öğün kartında da geçer — kaydet butonu erişilebilir
    // adıyla hedeflenir ki yanlışlıkla öğün seçimi toggle edilmesin.
    const submit = await screen.findByRole('button', { name: /Record 6\.00 kg/ });
    fireEvent.click(submit);

    await waitFor(() => expect(h.addToQueue).toHaveBeenCalledTimes(1));
    const [type, payload] = h.addToQueue.mock.calls[0] ?? [];
    expect(type).toBe('recordMealFeeding');
    expect(payload).toMatchObject({
      mealId: 'meal-1',
      pourKg: 6,
      finalize: true,
      feedingMethod: 'MANUAL',
    });
    // Two-phase success: the badge tracks the queued op, no unconditional green.
    expect((await screen.findByTestId('queued-status-badge')).textContent).toBe('op-1');
  });

  it('shows the no-plans hint when the day has no generated plans', async () => {
    h.graphqlRequest.mockResolvedValue({ feedingDayPlans: [] });

    render(createElement(RecordFeedingPage), { wrapper: wrapper(client) });

    await waitFor(() => expect(screen.getByText(/No feeding plans for today/i)).toBeTruthy());
  });
});
