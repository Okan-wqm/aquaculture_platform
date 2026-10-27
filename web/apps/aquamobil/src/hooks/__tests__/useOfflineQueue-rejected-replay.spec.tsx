/**
 * The foreground replay lane keeps the code of a rejection the gateway answers with HTTP 400
 * (PKG-42; ADR-051 C6).
 *
 * Apollo Server 5 answers a document that no longer validates against the schema — the
 * BREAKING-release case C6 exists for — with HTTP 400 and GRAPHQL_VALIDATION_FAILED, and a
 * variable it cannot coerce with HTTP 400 and BAD_USER_INPUT. The executor threw `HTTP error:
 * 400` before reading the body, so the op carried no code: the queue retried a payload that can
 * never succeed five times and the Sync Status page never listed it for re-entry. This spec runs
 * the real queue (an in-memory IndexedDB) under the real OfflineProvider; only the transport,
 * auth and React Query are doubles.
 */
import { webcrypto } from 'node:crypto';

import { act, cleanup, render } from '@testing-library/react';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TENANT = 'aaaaaaaa-0000-0000-0000-000000000001';

const h = vi.hoisted(() => ({
  stores: new Map<string, Map<string, unknown>>(),
  authenticatedFetch: vi.fn<(url: string, init: RequestInit) => Promise<Response>>(),
}));

function storeFor(store: unknown): Map<string, unknown> {
  const name = typeof store === 'string' ? store : 'queue-store';
  let map = h.stores.get(name);
  if (map === undefined) {
    map = new Map();
    h.stores.set(name, map);
  }
  return map;
}

vi.mock('idb-keyval', () => ({
  get: vi.fn((key: string, store?: unknown) => Promise.resolve(storeFor(store).get(key))),
  set: vi.fn((key: string, value: unknown, store?: unknown) => {
    storeFor(store).set(key, value);
    return Promise.resolve();
  }),
  del: vi.fn((key: string, store?: unknown) => {
    storeFor(store).delete(key);
    return Promise.resolve();
  }),
  keys: vi.fn((store?: unknown) => Promise.resolve(Array.from(storeFor(store).keys()))),
  entries: vi.fn((store?: unknown) => Promise.resolve(Array.from(storeFor(store).entries()))),
  createStore: vi.fn((dbName: string) => dbName),
}));

vi.mock('@/utils/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/services/authenticated-fetch', () => ({
  authenticatedFetch: h.authenticatedFetch,
  graphqlRequest: vi.fn(),
}));

vi.mock('../useNetworkStatus', () => ({ useNetworkStatus: () => true }));

vi.mock('../useAuth', () => ({
  useAuth: () => ({ accessToken: 'token', tenantId: TENANT, user: { id: 'u1' } }),
}));

vi.mock('../useOfflineCacheScope', () => ({ useRetainOfflineCacheScope: (): void => undefined }));

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

// AES-GCM needs real WebCrypto: the queue encrypts every payload at rest.
vi.stubGlobal('crypto', webcrypto);

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

import { getPendingOperations, isPermanentlyFailed, queueOperation } from '@/pwa/offline-queue';
import { isRejectedReplay } from '@/pwa/rejected-replays';
import type { QueuedOperation } from '@/types';

/** Queue one mortality record, as the record page does offline. */
async function queueMortality(): Promise<void> {
  await queueOperation(TENANT, 'recordMortality', {
    batchId: 'b1',
    tankId: 't1',
    quantity: 1,
    reason: 'UNKNOWN',
    observedAt: '2026-10-27T06:00:00.000Z',
  });
}

/** Mount the provider and run one sync, as the Sync Status page's button does. */
async function syncOnce(): Promise<void> {
  const sink: { syncNow?: () => Promise<SyncResult> } = {};
  function Probe(): null {
    sink.syncNow = useOfflineQueue().syncNow;
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
  const { syncNow } = sink;
  if (syncNow === undefined) throw new Error('the provider exposed no syncNow');
  await act(async () => {
    await syncNow();
  });
}

async function theOnlyOperation(): Promise<QueuedOperation> {
  const operations = await getPendingOperations(TENANT);
  const [operation] = operations;
  if (operations.length !== 1 || operation === undefined) {
    throw new Error(`expected one queued operation, found ${operations.length}`);
  }
  return operation;
}

describe('foreground replay of a rejected write (PKG-42, ADR-051 C6)', () => {
  beforeEach(() => {
    h.stores.clear();
    h.authenticatedFetch.mockReset();
  });
  afterEach(() => cleanup());

  it.each(['GRAPHQL_VALIDATION_FAILED', 'BAD_USER_INPUT'])(
    'an HTTP 400 rejection coded %s keeps its code, is not retried and is listed for re-entry',
    async (code) => {
      await queueMortality();
      h.authenticatedFetch.mockResolvedValue(
        new Response(JSON.stringify({ errors: [{ message: 'rejected', extensions: { code } }] }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

      await syncOnce();

      const rejected = await theOnlyOperation();
      expect(rejected.status).toBe('failed');
      expect(rejected.retryCount).toBe(1);
      expect(rejected.lastErrorCode).toBe(code);
      expect(isPermanentlyFailed(rejected)).toBe(true);
      expect(isRejectedReplay(rejected)).toBe(true);
    },
  );

  it('an edge error page (HTTP 502) stays a code-less failure the queue retries', async () => {
    await queueMortality();
    h.authenticatedFetch.mockResolvedValue(
      new Response('<html>502 Bad Gateway</html>', { status: 502 }),
    );

    await syncOnce();

    const failed = await theOnlyOperation();
    expect(failed.status).toBe('failed');
    expect(failed.lastError).toBe('HTTP error: 502');
    expect(failed.lastErrorCode).toBeUndefined();
    expect(isPermanentlyFailed(failed)).toBe(false);
    expect(isRejectedReplay(failed)).toBe(false);
  });
});
