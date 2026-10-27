/**
 * The encrypted offline read cache (MOB-MEDIUM-031, PKG-42).
 *
 * It used to be keyed by tenant and domain key, and every hook served it from one catch-all, so
 * a refusal by the server (FORBIDDEN, UNAUTHENTICATED) put cached alarms, tanks and readings on
 * screen exactly as an outage did. The one read path now:
 *   - keys every entry by tenant + user + the moduleAccess fingerprint (offline-cache-scope.ts);
 *   - serves the cached copy only when the server could not be reached;
 *   - purges the caller's entries when the server refuses the session (UNAUTHENTICATED, 401);
 *   - purges only the refused read's entry when the server refuses one read (FORBIDDEN, 403):
 *     a FORBIDDEN is answered per resolver — a farm-only worker is refused every sensor read
 *     (ADR-051 §4) while the tank screen polls live readings — and must not empty the farm
 *     copies that worker needs when the signal drops;
 *   - lets the error surface, cache untouched, for every other failure;
 * and the app keeps only the current scope on the device (retainOnlyCacheScope), so a token
 * whose grants changed leaves nothing cached under the old grants readable.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// --------------------------------------------------------------------------
// Collaborators — idb-keyval (an in-memory store) and the at-rest cipher
// --------------------------------------------------------------------------

const h = vi.hoisted(() => ({
  store: new Map<string, unknown>(),
  failWrites: false,
}));

vi.mock('idb-keyval', () => ({
  createStore: vi.fn(() => 'cache-store'),
  get: vi.fn((key: string) => Promise.resolve(h.store.get(key))),
  set: vi.fn((key: string, value: unknown) => {
    if (h.failWrites) return Promise.reject(new Error('QuotaExceededError'));
    h.store.set(key, value);
    return Promise.resolve();
  }),
  del: vi.fn((key: string) => {
    h.store.delete(key);
    return Promise.resolve();
  }),
  keys: vi.fn(() => Promise.resolve(Array.from(h.store.keys()))),
}));

// The cipher is the queue's (offline-queue.ts owns the device key); a reversible stand-in keeps
// the entries readable here while proving the cache never stores plaintext itself.
vi.mock('../offline-queue', () => ({
  encryptString: (plaintext: string): Promise<{ iv: string; ciphertext: string }> =>
    Promise.resolve({ iv: 'iv', ciphertext: `sealed:${plaintext}` }),
  decryptString: (_iv: string, ciphertext: string): Promise<string> =>
    Promise.resolve(ciphertext.replace(/^sealed:/, '')),
}));

vi.mock('@/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  GraphQLError,
  HttpStatusError,
  NetworkUnreachableError,
} from '../../services/request-failure';
import { clearCache, readThroughOfflineCache, retainOnlyCacheScope } from '../offline-cache';
import { offlineCacheScopeOf, type OfflineCacheScope } from '../offline-cache-scope';

function tokenWith(claims: unknown): string {
  const payload = btoa(JSON.stringify(claims))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `eyJhbGciOiJSUzI1NiJ9.${payload}.signature`;
}

function scopeFor(
  userId: string,
  moduleAccess: Record<string, string>,
  tenantId = 'tenant-1',
): OfflineCacheScope {
  const scope = offlineCacheScopeOf(tokenWith({ sub: userId, tenantId, moduleAccess }), null);
  if (scope === null) throw new Error('fixture token yields no scope');
  return scope;
}

const FARM_USER = scopeFor('user-a', { farm: 'MODULE_USER' });
const FARM_USER_REVOKED = scopeFor('user-a', {});
const OTHER_USER = scopeFor('user-b', { farm: 'MODULE_USER' });
const READ = { key: 'tanks', ttlMs: 60_000 } as const;
const TANKS = [{ id: 'tank-1' }];

function forbidden(): GraphQLError {
  return new GraphQLError([{ message: 'Forbidden resource', extensions: { code: 'FORBIDDEN' } }]);
}

/** Seed the cache for `scope` through the one write path: a successful read. */
async function seed(
  scope: OfflineCacheScope,
  data: unknown,
  key: string = READ.key,
): Promise<void> {
  await readThroughOfflineCache(scope, { key, ttlMs: READ.ttlMs }, () => Promise.resolve(data));
}

const offline = (): Promise<never> =>
  Promise.reject(new NetworkUnreachableError('Failed to fetch'));

describe('readThroughOfflineCache', () => {
  beforeEach(() => {
    h.store.clear();
    h.failWrites = false;
  });

  it('returns the network answer and keeps an encrypted copy under tenant, user and grants', async () => {
    const read = await readThroughOfflineCache(FARM_USER, READ, () => Promise.resolve(TANKS));

    expect(read).toEqual({ data: TANKS, servedFromCache: false });
    const stored = h.store.get(`cache_${FARM_USER.keyPrefix}tanks`);
    expect(stored).toMatchObject({ _enc: { iv: 'iv' } });
    expect(JSON.stringify(stored)).not.toContain('"id":"tank-1"');
  });

  it('serves the cached copy when the server cannot be reached', async () => {
    await seed(FARM_USER, TANKS);

    await expect(readThroughOfflineCache(FARM_USER, READ, offline)).resolves.toEqual({
      data: TANKS,
      servedFromCache: true,
    });
  });

  it('serves the cached copy when the edge reports the gateway down (HTTP 503)', async () => {
    await seed(FARM_USER, TANKS);

    const read = await readThroughOfflineCache(FARM_USER, READ, () =>
      Promise.reject(new HttpStatusError(503)),
    );
    expect(read.servedFromCache).toBe(true);
  });

  it('rethrows the outage when nothing is cached', async () => {
    await expect(readThroughOfflineCache(FARM_USER, READ, offline)).rejects.toBeInstanceOf(
      NetworkUnreachableError,
    );
  });

  it('never serves the cache when the server answers FORBIDDEN, and purges that read’s entry', async () => {
    await seed(FARM_USER, TANKS);

    await expect(
      readThroughOfflineCache(FARM_USER, READ, () => Promise.reject(forbidden())),
    ).rejects.toBeInstanceOf(GraphQLError);

    // Gone, so a later outage cannot bring the refused data back on screen.
    await expect(readThroughOfflineCache(FARM_USER, READ, offline)).rejects.toBeInstanceOf(
      NetworkUnreachableError,
    );
  });

  it('keeps the caller’s other entries servable when one read is refused (a farm-only worker’s sensor poll)', async () => {
    await seed(FARM_USER, TANKS);
    await seed(FARM_USER, [{ id: 'reading-1' }], 'readings_t1');

    for (const refusal of [forbidden(), new HttpStatusError(403)]) {
      await expect(
        readThroughOfflineCache(FARM_USER, { key: 'readings_t1', ttlMs: READ.ttlMs }, () =>
          Promise.reject(refusal),
        ),
      ).rejects.toBe(refusal);
    }

    // The signal drops: the tanks the worker read are still on the device.
    await expect(readThroughOfflineCache(FARM_USER, READ, offline)).resolves.toEqual({
      data: TANKS,
      servedFromCache: true,
    });
    await expect(
      readThroughOfflineCache(FARM_USER, { key: 'readings_t1', ttlMs: READ.ttlMs }, offline),
    ).rejects.toBeInstanceOf(NetworkUnreachableError);
  });

  it('purges every entry of the caller when the session is refused (UNAUTHENTICATED, HTTP 401)', async () => {
    for (const refusal of [
      new GraphQLError([{ message: 'Unauthorized', extensions: { code: 'UNAUTHENTICATED' } }]),
      new HttpStatusError(401),
    ]) {
      await seed(FARM_USER, TANKS);
      await seed(FARM_USER, [{ id: 'alarm-1' }], 'alerts');
      await seed(OTHER_USER, TANKS);

      await expect(
        readThroughOfflineCache(FARM_USER, READ, () => Promise.reject(refusal)),
      ).rejects.toBe(refusal);

      expect(h.store.has(`cache_${FARM_USER.keyPrefix}tanks`)).toBe(false);
      expect(h.store.has(`cache_${FARM_USER.keyPrefix}alerts`)).toBe(false);
      // Another user of the device keeps theirs.
      expect(h.store.has(`cache_${OTHER_USER.keyPrefix}tanks`)).toBe(true);
    }
  });

  it('lets any other failure surface without serving or purging the cache', async () => {
    await seed(FARM_USER, TANKS);
    const badInput = new GraphQLError([{ message: 'bad', extensions: { code: 'BAD_USER_INPUT' } }]);

    await expect(
      readThroughOfflineCache(FARM_USER, READ, () => Promise.reject(badInput)),
    ).rejects.toBe(badInput);
    await expect(
      readThroughOfflineCache(FARM_USER, READ, () => Promise.reject(new TypeError('mapper bug'))),
    ).rejects.toBeInstanceOf(TypeError);
    expect(h.store.has(`cache_${FARM_USER.keyPrefix}tanks`)).toBe(true);
  });

  it('never serves an entry written under grants the caller no longer holds', async () => {
    await seed(FARM_USER, TANKS);

    await expect(readThroughOfflineCache(FARM_USER_REVOKED, READ, offline)).rejects.toBeInstanceOf(
      NetworkUnreachableError,
    );
  });

  it('leaves no farm entry servable once the token’s moduleAccess drops farm', async () => {
    await seed(FARM_USER, TANKS);
    await seed(FARM_USER, [{ id: 'plan-1' }], 'day_plans');

    // The next token's scope is the only one the app keeps (useRetainOfflineCacheScope).
    await retainOnlyCacheScope(FARM_USER_REVOKED);

    for (const key of ['tanks', 'day_plans']) {
      await expect(
        readThroughOfflineCache(FARM_USER_REVOKED, { key, ttlMs: READ.ttlMs }, offline),
      ).rejects.toBeInstanceOf(NetworkUnreachableError);
    }
    expect(h.store.size).toBe(0);
  });

  it("never serves one user's entry to another user of the same tenant", async () => {
    await seed(FARM_USER, TANKS);

    await expect(readThroughOfflineCache(OTHER_USER, READ, offline)).rejects.toBeInstanceOf(
      NetworkUnreachableError,
    );
  });

  it('does not serve an expired entry, and deletes it', async () => {
    await readThroughOfflineCache(FARM_USER, { key: 'tanks', ttlMs: -1 }, () =>
      Promise.resolve(TANKS),
    );

    await expect(readThroughOfflineCache(FARM_USER, READ, offline)).rejects.toBeInstanceOf(
      NetworkUnreachableError,
    );
    expect(h.store.size).toBe(0);
  });

  it('reads the network only, and writes nothing, without a scope', async () => {
    await expect(
      readThroughOfflineCache(null, READ, () => Promise.resolve(TANKS)),
    ).resolves.toEqual({
      data: TANKS,
      servedFromCache: false,
    });
    expect(h.store.size).toBe(0);
    await expect(readThroughOfflineCache(null, READ, offline)).rejects.toBeInstanceOf(
      NetworkUnreachableError,
    );
  });

  it('still returns the network answer when the device cannot store the copy', async () => {
    h.failWrites = true;

    await expect(
      readThroughOfflineCache(FARM_USER, READ, () => Promise.resolve(TANKS)),
    ).resolves.toEqual({
      data: TANKS,
      servedFromCache: false,
    });
  });
});

describe('retainOnlyCacheScope', () => {
  beforeEach(() => {
    h.store.clear();
    h.failWrites = false;
  });

  it('keeps the current scope and deletes every other entry on the device', async () => {
    await seed(FARM_USER, TANKS);
    await seed(FARM_USER_REVOKED, TANKS);
    await seed(OTHER_USER, TANKS);
    await seed(scopeFor('user-a', { farm: 'MODULE_USER' }, 'tenant-2'), TANKS);

    await retainOnlyCacheScope(FARM_USER_REVOKED);

    expect(Array.from(h.store.keys())).toEqual([`cache_${FARM_USER_REVOKED.keyPrefix}tanks`]);
  });
});

describe('clearCache', () => {
  beforeEach(() => {
    h.store.clear();
    h.failWrites = false;
  });

  it('wipes every entry of every scope (the logout wipe)', async () => {
    await seed(FARM_USER, TANKS);
    await seed(OTHER_USER, TANKS);

    await clearCache();

    expect(h.store.size).toBe(0);
  });
});
