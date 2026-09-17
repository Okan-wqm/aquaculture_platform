/**
 * OfflineProvider auto-sync re-arm tests — FE-HIGH-051.
 *
 * The reconnect auto-sync guard must re-fire whenever the queue CONTENT changes,
 * not merely when the pending COUNT changes. The classic miss is a
 * drain-to-N-then-enqueue-back-to-N sequence: the observed count is unchanged,
 * yet a genuinely new operation must sync. The guard is now keyed on the
 * monotonic queue VERSION (bumped on every enqueue), so this case re-arms.
 *
 * These tests drive the provider with the offline-queue module mocked, so we
 * control getQueueVersion / getPendingCount / syncAllOperations directly and
 * assert how many times the auto-sync effect kicks off a sync.
 */

import { render, act, cleanup } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

// --------------------------------------------------------------------------
// Mocks — declared before imports (hoisted by vitest)
// --------------------------------------------------------------------------

let mockPendingCount = 0;
let mockQueueVersion = 0;
let mockIsOnline = true;

const mockSyncAllOperations =
  vi.fn<(...args: unknown[]) => Promise<{ success: number; failed: number }>>();
const mockGetPendingOperations = vi.fn<(...args: unknown[]) => Promise<unknown[]>>();

vi.mock('@/pwa/offline-queue', () => ({
  // Read paths the provider polls — return the test-controlled values. The
  // factory is hoisted above the const declarations, so the spy references are
  // indirected through typed arrow wrappers (a direct reference would evaluate the
  // not-yet-initialised binding). Explicit return types keep no-unsafe-return clean.
  getPendingCount: vi.fn(() => Promise.resolve(mockPendingCount)),
  getPendingOperations: (...args: unknown[]): Promise<unknown[]> =>
    mockGetPendingOperations(...args),
  getQueueVersion: vi.fn(() => Promise.resolve(mockQueueVersion)),
  syncAllOperations: (...args: unknown[]): Promise<{ success: number; failed: number }> =>
    mockSyncAllOperations(...args),
  queueOperation: vi.fn(),
  removeOperation: vi.fn(),
  MAX_RETRY_COUNT: 5,
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

// Capture the provider's service-worker 'message' listener so the test can fire
// SYNC_COMPLETE, which re-runs refreshQueue() and re-reads the mock version —
// the same path the real SW uses to tell the provider the queue changed. This
// lets ONE provider instance observe a version bump (no second mount, which
// would reset the re-arm ref and invalidate the assertion).
let swMessageHandler: ((event: MessageEvent) => void) | null = null;
Object.defineProperty(globalThis, 'navigator', {
  value: {
    ...globalThis.navigator,
    serviceWorker: {
      addEventListener: (type: string, handler: (event: MessageEvent) => void) => {
        if (type === 'message') swMessageHandler = handler;
      },
      removeEventListener: vi.fn(),
    },
  },
  configurable: true,
  writable: true,
});

// Import after mocks.
import { OfflineProvider } from '../useOfflineQueue';

// The auto-sync effect waits 1000ms before kicking off — drive it with fake timers.
beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  swMessageHandler = null;
  mockPendingCount = 0;
  mockQueueVersion = 0;
  mockIsOnline = true;
  mockSyncAllOperations.mockResolvedValue({ success: 0, failed: 0 });
  mockGetPendingOperations.mockResolvedValue([]);
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  cleanup();
});

/** Render ONE provider instance and flush its mount-time refreshQueue microtasks. */
async function mountProvider(): Promise<void> {
  await act(async () => {
    render(
      <OfflineProvider>
        <div />
      </OfflineProvider>,
    );
    // Let the provider's awaited refreshQueue reads settle inside this act().
    await Promise.resolve();
  });
}

/** Simulate the service worker telling the provider the queue changed. */
async function fireSyncComplete(): Promise<void> {
  await act(async () => {
    swMessageHandler?.({ data: { type: 'SYNC_COMPLETE' } } as MessageEvent);
    await Promise.resolve();
  });
}

describe('OfflineProvider auto-sync re-arm (FE-HIGH-051)', () => {
  it('re-fires sync on a drain-then-enqueue even when the pending count is unchanged', async () => {
    // Start online with one pending op at version 1.
    mockPendingCount = 1;
    mockQueueVersion = 1;

    await mountProvider();

    // First arm: the 1000ms debounce elapses and a sync kicks off.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(mockSyncAllOperations).toHaveBeenCalledTimes(1);

    // Simulate: the op drained (count 0) then a NEW op enqueued (count back to 1,
    // version bumped to 2). The count is IDENTICAL to before — only the version
    // moved. The SW message re-reads the queue on the SAME provider instance.
    mockPendingCount = 1;
    mockQueueVersion = 2;
    await fireSyncComplete();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    // The version change re-armed the guard, so a second sync kicked off — the
    // exact case a count-delta guard would have missed.
    expect(mockSyncAllOperations).toHaveBeenCalledTimes(2);
  });

  it('does NOT re-fire when the queue is re-read but the version is unchanged', async () => {
    mockPendingCount = 1;
    mockQueueVersion = 1;

    await mountProvider();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(mockSyncAllOperations).toHaveBeenCalledTimes(1);

    // A queue re-read with the SAME version + count must NOT re-arm.
    await fireSyncComplete();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    expect(mockSyncAllOperations).toHaveBeenCalledTimes(1);
  });
});
