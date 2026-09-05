/**
 * SW closed-app queue replay spec (MOB-MEDIUM-002).
 *
 * The old `sync` handler only posted SYNC_COMPLETE to OPEN window clients —
 * with the app closed there was nobody to notify, so "background sync" was a
 * no-op and offline records sat stranded until the next launch (while a code
 * comment claimed the SW re-POSTs /graphql). This spec pins the real replay:
 *   - ≥1 open client → delegate to the foreground drain (no double-execution)
 *   - zero clients   → refresh via the httpOnly cookie, then drain the queue
 *   - refresh failure → silent no-op, queue intact
 *   - blob-lane ops (uploadAndSendMessage) are skipped, untouched
 *   - tenant scoping: only the refreshed identity's tenant drains
 *   - no Web Locks / lock contention → no drain (mutual exclusion is required)
 */

import { webcrypto } from 'node:crypto';

import { vi, describe, it, expect, beforeEach, afterAll } from 'vitest';

// --------------------------------------------------------------------------
// Mocks — idb-keyval (same in-memory strategy as offline-queue.spec.ts)
// --------------------------------------------------------------------------

const idbStore = new Map<string, unknown>();
const cacheIdbStore = new Map<string, unknown>();
const keyIdbStore = new Map<string, unknown>();
const blobIdbStore = new Map<string, unknown>();

function storeFor(store?: unknown): Map<string, unknown> {
  if (store === 'cache-store') return cacheIdbStore;
  if (store === 'key-store') return keyIdbStore;
  if (store === 'blob-store') return blobIdbStore;
  return idbStore;
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
  createStore: vi.fn((dbName: string) => {
    if (dbName.includes('cache')) return 'cache-store';
    if (dbName.includes('keys')) return 'key-store';
    if (dbName.includes('blobs')) return 'blob-store';
    return 'queue-store';
  }),
}));

vi.mock('@/utils/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

// AES-GCM needs real WebCrypto in the node test env.
vi.stubGlobal('crypto', webcrypto);

import { getPendingOperations, queueOperation } from '../offline-queue';
import { handleBackgroundSyncEvent, type BackgroundSyncScope } from '../sw-replay';

// --------------------------------------------------------------------------
// Fake SW global
// --------------------------------------------------------------------------

interface FakeSwOptions {
  clients?: Array<{ postMessage: ReturnType<typeof vi.fn> }>;
  locksAvailable?: boolean;
  lockGrantable?: boolean;
}

function fakeSw(options: FakeSwOptions = {}): {
  sw: BackgroundSyncScope;
  clients: Array<{ postMessage: ReturnType<typeof vi.fn> }>;
} {
  const clients = options.clients ?? [];
  const locks =
    options.locksAvailable === false
      ? undefined
      : {
          request: vi.fn(
            (
              _name: string,
              optsOrCb: unknown,
              maybeCb?: (lock: unknown) => Promise<void>,
            ): Promise<void> => {
              const callback = (maybeCb ?? optsOrCb) as (lock: unknown) => Promise<void>;
              const granted = options.lockGrantable !== false;
              return Promise.resolve(callback(granted ? { name: _name } : null));
            },
          ),
        };
  const sw: BackgroundSyncScope = {
    clients: {
      matchAll: vi.fn(() => Promise.resolve(clients)),
    },
    navigator: locks ? { locks } : {},
  };
  return { sw, clients };
}

const TENANT_A = 'aaaaaaaa-0000-0000-0000-000000000001';
const TENANT_B = 'bbbbbbbb-0000-0000-0000-000000000002';

function refreshResponse(tenantId: string): Response {
  return new Response(
    JSON.stringify({
      data: {
        refreshToken: {
          accessToken: 'sw-access-token',
          user: { id: 'user-1', tenantId },
        },
      },
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

function graphqlOkResponse(): Response {
  return new Response(JSON.stringify({ data: { recordMortality: { id: 'x' } } }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

describe('handleBackgroundSyncEvent (MOB-MEDIUM-002)', () => {
  beforeEach(() => {
    idbStore.clear();
    cacheIdbStore.clear();
    keyIdbStore.clear();
    blobIdbStore.clear();
    fetchMock.mockReset();
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it('delegates to open window clients without touching the network', async () => {
    await queueOperation(TENANT_A, 'recordMortality', { batchId: 'b1', quantity: 1 } as never);
    const { sw, clients } = fakeSw({ clients: [{ postMessage: vi.fn() }, { postMessage: vi.fn() }] });

    await handleBackgroundSyncEvent(sw);

    for (const client of clients) {
      expect(client.postMessage).toHaveBeenCalledWith({ type: 'SYNC_COMPLETE' });
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await getPendingOperations(TENANT_A)).toHaveLength(1);
  });

  it('with zero clients: refreshes via the cookie, drains the queue with auth headers', async () => {
    await queueOperation(TENANT_A, 'recordMortality', { batchId: 'b1', quantity: 2 } as never);
    fetchMock
      .mockResolvedValueOnce(refreshResponse(TENANT_A))
      .mockResolvedValue(graphqlOkResponse());
    const { sw } = fakeSw();

    await handleBackgroundSyncEvent(sw);

    // Call 1 — the RefreshToken mutation with the httpOnly cookie.
    const [refreshUrl, refreshInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(refreshUrl).toBe('/graphql');
    expect(refreshInit.credentials).toBe('include');
    const refreshBody = typeof refreshInit.body === 'string' ? refreshInit.body : '';
    expect(refreshBody).toContain('refreshToken');
    expect((refreshInit.headers as Record<string, string>)['X-Requested-With']).toBe('XMLHttpRequest');

    // Call 2 — the queued mutation with the minted token + tenant header.
    const [opUrl, opInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(opUrl).toBe('/graphql');
    const headers = opInit.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer sw-access-token');
    expect(headers['X-Tenant-Id']).toBe(TENANT_A);
    expect(headers['X-Requested-With']).toBe('XMLHttpRequest');
    const opBody = typeof opInit.body === 'string' ? opInit.body : '';
    expect(opBody).toContain('RecordMortality');
    // The envelope survives verbatim under `input`.
    expect(opBody).toContain('clientCommandId');

    expect(await getPendingOperations(TENANT_A)).toHaveLength(0);
  });

  it('a failed refresh is a silent no-op — the queue stays intact', async () => {
    await queueOperation(TENANT_A, 'recordMortality', { batchId: 'b1', quantity: 1 } as never);
    fetchMock.mockResolvedValueOnce(new Response('unauthorized', { status: 401 }));
    const { sw } = fakeSw();

    await handleBackgroundSyncEvent(sw);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const remaining = await getPendingOperations(TENANT_A);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.retryCount).toBe(0);
  });

  it('skips the blob lane: uploadAndSendMessage stays queued with retryCount 0', async () => {
    await queueOperation(TENANT_A, 'uploadAndSendMessage', {
      blobId: 'blob-1',
      channelId: 'chan-1',
    } as never);
    await queueOperation(TENANT_A, 'sendMessage', {
      channelId: 'chan-1',
      content: 'hi',
    } as never);
    fetchMock
      .mockResolvedValueOnce(refreshResponse(TENANT_A))
      .mockResolvedValue(
        new Response(JSON.stringify({ data: { sendMessage: { id: 'm1' } } }), { status: 200 }),
      );
    const { sw } = fakeSw();

    await handleBackgroundSyncEvent(sw);

    const remaining = await getPendingOperations(TENANT_A);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.type).toBe('uploadAndSendMessage');
    expect(remaining[0]?.retryCount).toBe(0);
  });

  it('drains ONLY the refreshed identity tenant — other tenants untouched', async () => {
    await queueOperation(TENANT_A, 'recordMortality', { batchId: 'a', quantity: 1 } as never);
    await queueOperation(TENANT_B, 'recordMortality', { batchId: 'b', quantity: 1 } as never);
    fetchMock
      .mockResolvedValueOnce(refreshResponse(TENANT_A))
      .mockResolvedValue(graphqlOkResponse());
    const { sw } = fakeSw();

    await handleBackgroundSyncEvent(sw);

    expect(await getPendingOperations(TENANT_A)).toHaveLength(0);
    expect(await getPendingOperations(TENANT_B)).toHaveLength(1);
  });

  it('without Web Locks there is no cross-context mutual exclusion → no drain', async () => {
    await queueOperation(TENANT_A, 'recordMortality', { batchId: 'b1', quantity: 1 } as never);
    const { sw } = fakeSw({ locksAvailable: false });

    await handleBackgroundSyncEvent(sw);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(await getPendingOperations(TENANT_A)).toHaveLength(1);
  });

  it('a contended lock (foreground drain in progress) → no drain from the SW', async () => {
    await queueOperation(TENANT_A, 'recordMortality', { batchId: 'b1', quantity: 1 } as never);
    const { sw } = fakeSw({ lockGrantable: false });

    await handleBackgroundSyncEvent(sw);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(await getPendingOperations(TENANT_A)).toHaveLength(1);
  });

  it('a GraphQL error marks the op failed (retryable) instead of dropping it', async () => {
    await queueOperation(TENANT_A, 'recordMortality', { batchId: 'b1', quantity: 1 } as never);
    fetchMock
      .mockResolvedValueOnce(refreshResponse(TENANT_A))
      .mockResolvedValue(
        new Response(JSON.stringify({ errors: [{ message: 'server exploded' }] }), { status: 200 }),
      );
    const { sw } = fakeSw();

    await handleBackgroundSyncEvent(sw);

    const remaining = await getPendingOperations(TENANT_A);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.status).toBe('failed');
    expect(remaining[0]?.retryCount).toBe(1);
    expect(remaining[0]?.lastErrorCode).toBeUndefined();
  });

  it('a GraphQL error with a permanent extensions.code is recorded and not re-drained', async () => {
    await queueOperation(TENANT_A, 'recordMortality', { batchId: 'b1', quantity: 1 } as never);
    fetchMock
      .mockResolvedValueOnce(refreshResponse(TENANT_A))
      .mockResolvedValue(
        new Response(
          JSON.stringify({
            errors: [{ message: 'Variable "$input" got invalid value', extensions: { code: 'BAD_USER_INPUT' } }],
          }),
          { status: 200 },
        ),
      );
    const { sw } = fakeSw();

    await handleBackgroundSyncEvent(sw);

    const [failed] = await getPendingOperations(TENANT_A);
    expect(failed?.status).toBe('failed');
    expect(failed?.retryCount).toBe(1);
    expect(failed?.lastErrorCode).toBe('BAD_USER_INPUT');

    // A second background sync must not POST the same doomed payload again
    // (the SW still mints its identity through the refresh mutation, so filter
    // on the replayed document rather than on the /graphql URL).
    const postsBefore = fetchMock.mock.calls.length;
    await handleBackgroundSyncEvent(fakeSw().sw);
    const replayPostsAfter = fetchMock.mock.calls
      .slice(postsBefore)
      .filter((call) => JSON.stringify(call).includes('RecordMortality'));
    expect(replayPostsAfter).toHaveLength(0);
    expect((await getPendingOperations(TENANT_A))[0]?.retryCount).toBe(1);
  });
});
