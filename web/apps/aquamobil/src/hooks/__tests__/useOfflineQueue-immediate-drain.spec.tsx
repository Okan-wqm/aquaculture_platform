/**
 * OfflineProvider.addToQueue — MOB-CRITICAL-020 two-phase UX.
 *
 * The auto-sync effect arms a 1 s timer on every queue-version change, and the
 * queue-first write pages navigate away 2 s after enqueue — so an ONLINE submit
 * routinely left the badge on "Queued" instead of reaching "Confirmed". An
 * online enqueue now drains immediately; the timer stays as the safety net.
 */
import { render, act, cleanup } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';

let mockIsOnline = true;
const mockQueueOperation = vi.fn<(...args: unknown[]) => Promise<unknown>>();
const mockSyncAllOperations = vi.fn<(...args: unknown[]) => Promise<unknown>>();

vi.mock('@/pwa/offline-queue', () => ({
  getPendingCount: vi.fn(() => Promise.resolve(0)),
  getPendingOperations: vi.fn(() => Promise.resolve([])),
  getQueueVersion: vi.fn(() => Promise.resolve(0)),
  syncAllOperations: (...args: unknown[]): Promise<unknown> => mockSyncAllOperations(...args),
  queueOperation: (...args: unknown[]): Promise<unknown> => mockQueueOperation(...args),
  removeOperation: vi.fn(),
  getPendingBlob: vi.fn(),
  removePendingBlob: vi.fn(),
  MAX_RETRY_COUNT: 5,
}));

vi.mock('@/services/authenticated-fetch', () => ({
  graphqlRequest: vi.fn(),
}));

vi.mock('@/graphql/messaging-operations', () => ({
  REQUEST_MEDIA_UPLOAD: 'REQUEST_MEDIA_UPLOAD',
  SEND_MESSAGE: 'SEND_MESSAGE',
}));

vi.mock('../useNetworkStatus', () => ({
  useNetworkStatus: () => mockIsOnline,
}));

vi.mock('../useAuth', () => ({
  useAuth: () => ({
    accessToken: 'token',
    tenantId: 'tenant-1',
    user: { id: 'u1' },
    refreshAuth: vi.fn(),
  }),
}));

vi.mock('@tanstack/react-query', async () => {
  const actual =
    await vi.importActual<typeof import('@tanstack/react-query')>('@tanstack/react-query');
  return {
    ...actual,
    useQueryClient: () => ({ invalidateQueries: vi.fn().mockResolvedValue(undefined) }),
  };
});

vi.mock('@/utils/offline-sync-invalidation', () => ({
  invalidateSyncedOperationQueries: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/utils/offline-optimistic', () => ({
  applyOptimisticKpiBump: vi.fn(),
}));

const realNavigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
Object.defineProperty(globalThis, 'navigator', {
  value: {
    ...globalThis.navigator,
    serviceWorker: { addEventListener: vi.fn(), removeEventListener: vi.fn() },
  },
  configurable: true,
  writable: true,
});
afterAll(() => {
  if (realNavigatorDescriptor) {
    Object.defineProperty(globalThis, 'navigator', realNavigatorDescriptor);
  }
});

import { OfflineProvider, useOfflineQueue } from '../useOfflineQueue';

type AddToQueue = ReturnType<typeof useOfflineQueue>['addToQueue'];

const MORTALITY = {
  batchId: 'b1',
  tankId: 't1',
  quantity: 5,
  reason: 'DISEASE' as const,
  observedAt: '2026-01-01T00:00:00.000Z',
};

async function mountAddToQueue(): Promise<{ addToQueue: AddToQueue }> {
  const sink: { addToQueue?: AddToQueue } = {};
  function Probe(): null {
    sink.addToQueue = useOfflineQueue().addToQueue;
    return null;
  }
  await act(async () => {
    render(
      <OfflineProvider>
        <Probe />
      </OfflineProvider>,
    );
    await Promise.resolve();
  });
  if (sink.addToQueue === undefined) throw new Error('OfflineProvider did not expose addToQueue');
  return { addToQueue: sink.addToQueue };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockIsOnline = true;
  mockSyncAllOperations.mockResolvedValue({ success: 1, failed: 0 });
});

afterEach(() => cleanup());

describe('addToQueue drains immediately when online (MOB-CRITICAL-020)', () => {
  it('starts a drain right after a fresh online enqueue, without waiting for the 1 s timer', async () => {
    mockQueueOperation.mockResolvedValue({ status: 'queued', id: 'op-1' });
    const { addToQueue } = await mountAddToQueue();

    await act(async () => {
      await addToQueue('recordMortality', MORTALITY);
    });

    expect(mockQueueOperation).toHaveBeenCalledTimes(1);
    expect(mockSyncAllOperations).toHaveBeenCalledTimes(1);
    expect(mockSyncAllOperations.mock.calls[0]?.[0]).toBe('tenant-1');
  });

  it('does not drain when offline — the record waits for reconnect', async () => {
    mockIsOnline = false;
    mockQueueOperation.mockResolvedValue({ status: 'queued', id: 'op-1' });
    const { addToQueue } = await mountAddToQueue();

    await act(async () => {
      await addToQueue('recordMortality', MORTALITY);
    });

    expect(mockSyncAllOperations).not.toHaveBeenCalled();
  });

  it('does not start a second drain for a deduped double-tap', async () => {
    mockQueueOperation.mockResolvedValue({ status: 'duplicate', id: 'op-0' });
    const { addToQueue } = await mountAddToQueue();

    await act(async () => {
      await addToQueue('recordMortality', MORTALITY);
    });

    expect(mockSyncAllOperations).not.toHaveBeenCalled();
  });
});
