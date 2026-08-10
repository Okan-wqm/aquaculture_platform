/**
 * OfflineProvider getSyncStatus tests — FE-LOW-050.
 *
 * Before the fix, getSyncStatus returned 'synced' for ANY id absent from
 * pendingOperations — including a never-seen/typo'd id — rendering a false
 * green "Confirmed". The fix returns 'unknown' for an id absent from BOTH the
 * syncResults drain map AND the pending queue, while a genuinely-drained op
 * (recorded 'synced' in syncResults) still resolves to 'synced'.
 */
import { render, act, cleanup } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';

let mockIsOnline = true;
const mockGetPendingOperations = vi.fn<(...args: unknown[]) => Promise<unknown[]>>();

vi.mock('@/pwa/offline-queue', () => ({
  getPendingCount: vi.fn(() => Promise.resolve(0)),
  getPendingOperations: (...args: unknown[]): Promise<unknown[]> =>
    mockGetPendingOperations(...args),
  getQueueVersion: vi.fn(() => Promise.resolve(0)),
  syncAllOperations: vi.fn(() => Promise.resolve({ success: 0, failed: 0 })),
  queueOperation: vi.fn(),
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

// Capture the real navigator so it can be restored after this file — otherwise the
// service-worker mock leaks into other spec files when the full suite runs in one worker.
const realNavigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
Object.defineProperty(globalThis, 'navigator', {
  value: {
    ...globalThis.navigator,
    serviceWorker: {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    },
  },
  configurable: true,
  writable: true,
});
afterAll(() => {
  if (realNavigatorDescriptor) {
    Object.defineProperty(globalThis, 'navigator', realNavigatorDescriptor);
  }
});

import { OfflineProvider, useOfflineQueue, type SyncStatus } from '../useOfflineQueue';

beforeEach(() => {
  vi.clearAllMocks();
  mockIsOnline = true;
  mockGetPendingOperations.mockResolvedValue([]);
});

afterEach(() => cleanup());

/** Probe component that reports getSyncStatus(id) into a ref the test reads. */
function makeProbe(id: string, sink: { status?: SyncStatus }): () => null {
  return function Probe(): null {
    const { getSyncStatus } = useOfflineQueue();
    sink.status = getSyncStatus(id);
    return null;
  };
}

async function mount(id: string, sink: { status?: SyncStatus }): Promise<void> {
  const Probe = makeProbe(id, sink);
  await act(async () => {
    render(
      <OfflineProvider>
        <Probe />
      </OfflineProvider>,
    );
    await Promise.resolve();
  });
}

describe('getSyncStatus (FE-LOW-050)', () => {
  it("returns 'unknown' for an id absent from both the drain map and the queue", async () => {
    const sink: { status?: SyncStatus } = {};
    await mount('never-seen-id', sink);
    expect(sink.status).toBe('unknown');
  });

  it("returns 'pending' for an id present in the pending queue", async () => {
    mockGetPendingOperations.mockResolvedValue([
      { id: 'op-1', tenantId: 'tenant-1', type: 'recordMortality', status: 'pending' },
    ]);
    const sink: { status?: SyncStatus } = {};
    await mount('op-1', sink);
    expect(sink.status).toBe('pending');
  });
});
