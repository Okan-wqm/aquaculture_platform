/**
 * Offline-sync single auth-lane regression (MSG-CRITICAL-057 / MSG-HIGH-060).
 *
 * Before the fix the offline-sync executor used a raw fetch('/graphql') with a
 * stale accessToken closure and NO 401 refresh, while syncNow separately called
 * refreshAuth() before the batch. Those were two uncoalesced refresh-token
 * rotation lanes: on reconnect they could rotate the same refresh cookie
 * concurrently, trip server-side reuse detection, force a logout, and
 * clearAllOperations() wiped every unsynced queued write.
 *
 * The fix routes replay through authenticatedFetch (the ONE lane: auth-ready
 * barrier + single-flight 401 refresh reading the live token) and deletes the
 * pre-sync refreshAuth() call — refreshAuth is no longer even in scope. These
 * tests pin both halves: sync uses authenticatedFetch, and sync never calls
 * refreshAuth directly.
 */
import { render, act, cleanup } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';

const mockRefreshAuth = vi.fn().mockResolvedValue(undefined);
const mockAuthenticatedFetch = vi.fn(() =>
  Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve({ data: { deleteMessage: true } }),
  }),
);

// syncAllOperations invokes the executor once (a deleteMessage replay) so the
// executor's transport is exercised, then reports one success.
const mockSyncAllOperations = vi.fn(
  async (
    _tenantId: string,
    executeGraphQL: (type: string, payload: unknown) => Promise<unknown>,
  ) => {
    await executeGraphQL('deleteMessage', { id: 'm1' });
    return { success: 1, failed: 0 };
  },
);

vi.mock('@/pwa/offline-queue', () => ({
  getPendingCount: vi.fn(() => Promise.resolve(0)),
  getPendingOperations: vi.fn(() => Promise.resolve([])),
  getQueueVersion: vi.fn(() => Promise.resolve(0)),
  syncAllOperations: (...args: Parameters<typeof mockSyncAllOperations>) =>
    mockSyncAllOperations(...args),
  queueOperation: vi.fn(),
  removeOperation: vi.fn(),
  getPendingBlob: vi.fn(),
  removePendingBlob: vi.fn(),
  MAX_RETRY_COUNT: 5,
}));

vi.mock('@/services/authenticated-fetch', () => ({
  authenticatedFetch: (...args: unknown[]): unknown => mockAuthenticatedFetch(...(args as [])),
  graphqlRequest: vi.fn(),
}));

vi.mock('@/graphql/messaging-operations', () => ({
  REQUEST_MEDIA_UPLOAD: 'REQUEST_MEDIA_UPLOAD',
  SEND_MESSAGE: 'SEND_MESSAGE',
}));

let mockIsOnline = true;
vi.mock('../useNetworkStatus', () => ({
  useNetworkStatus: () => mockIsOnline,
}));

vi.mock('../useAuth', () => ({
  useAuth: () => ({
    accessToken: 'token',
    tenantId: 'tenant-1',
    user: { id: 'u1' },
    refreshAuth: mockRefreshAuth,
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

import { OfflineProvider, useOfflineQueue, type SyncResult } from '../useOfflineQueue';

beforeEach(() => {
  vi.clearAllMocks();
  mockIsOnline = true;
});
afterEach(() => cleanup());

/** Probe that captures syncNow so the test can drive one sync. */
function makeProbe(sink: { syncNow?: () => Promise<SyncResult> }): () => null {
  return function Probe(): null {
    const { syncNow } = useOfflineQueue();
    sink.syncNow = syncNow;
    return null;
  };
}

async function driveSync(): Promise<void> {
  const sink: { syncNow?: () => Promise<SyncResult> } = {};
  const Probe = makeProbe(sink);
  await act(async () => {
    render(
      <OfflineProvider>
        <Probe />
      </OfflineProvider>,
    );
    await Promise.resolve();
  });
  await act(async () => {
    await sink.syncNow?.();
  });
}

describe('offline-sync single auth lane (MSG-CRITICAL-057 / MSG-HIGH-060)', () => {
  it('replays through authenticatedFetch (the single-flight lane), not a raw fetch', async () => {
    await driveSync();
    expect(mockSyncAllOperations).toHaveBeenCalledTimes(1);
    expect(mockAuthenticatedFetch).toHaveBeenCalledWith(
      '/graphql',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('never calls refreshAuth directly during sync (no second rotation lane)', async () => {
    await driveSync();
    expect(mockRefreshAuth).not.toHaveBeenCalled();
  });
});
