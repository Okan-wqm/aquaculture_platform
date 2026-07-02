import { RedisService } from '@aquaculture/backend-common/redis';

export interface RedisServiceMock
  extends Pick<
    RedisService,
    | 'get'
    | 'set'
    | 'del'
    | 'incr'
    | 'expire'
    | 'deletePattern'
    | 'setJson'
    | 'getJson'
    | 'sadd'
    | 'srem'
    | 'smembers'
    | 'setNx'
    | 'scan'
  > {
  store: Map<string, string>;
  sets: Map<string, Set<string>>;
  reset(): void;
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped.replace(/\*/g, '.*')}$`);
}

export function createRedisServiceMock(): RedisServiceMock {
  const store = new Map<string, string>();
  const sets = new Map<string, Set<string>>();
  const setJson: RedisService['setJson'] = async <T>(
    key: string,
    value: T,
    _ttlSeconds?: number,
  ): Promise<void> => {
    store.set(key, JSON.stringify(value));
  };
  const getJson: RedisService['getJson'] = async <T>(key: string): Promise<T | null> => {
    const raw = store.get(key);
    if (!raw) {
      return null;
    }
    return JSON.parse(raw) as T;
  };

  return {
    store,
    sets,
    reset: () => {
      store.clear();
      sets.clear();
    },
    get: jest.fn(async (key: string) => store.get(key) ?? null),
    set: jest.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    setJson,
    getJson,
    del: jest.fn(async (key: string) => {
      const valueDeleted = store.delete(key);
      const setDeleted = sets.delete(key);
      return valueDeleted || setDeleted ? 1 : 0;
    }),
    incr: jest.fn(async (key: string) => {
      const current = parseInt(store.get(key) ?? '0', 10);
      const next = current + 1;
      store.set(key, String(next));
      return next;
    }),
    sadd: jest.fn(async (key: string, ...members: string[]) => {
      const set = sets.get(key) ?? new Set<string>();
      let added = 0;
      for (const member of members) {
        if (!set.has(member)) {
          added++;
        }
        set.add(member);
      }
      sets.set(key, set);
      return added;
    }),
    srem: jest.fn(async (key: string, ...members: string[]) => {
      const set = sets.get(key);
      if (!set) {
        return 0;
      }
      let removed = 0;
      for (const member of members) {
        if (set.delete(member)) {
          removed++;
        }
      }
      return removed;
    }),
    smembers: jest.fn(async (key: string) => Array.from(sets.get(key) ?? [])),
    setNx: jest.fn(async (key: string, value: string, _ttlSeconds?: number) => {
      if (store.has(key)) {
        return false;
      }
      store.set(key, value);
      return true;
    }),
    expire: jest.fn(async () => true),
    deletePattern: jest.fn(async (pattern: string) => {
      const matcher = globToRegExp(pattern);
      let deleted = 0;
      for (const key of Array.from(store.keys())) {
        if (matcher.test(key)) {
          store.delete(key);
          deleted++;
        }
      }
      for (const key of Array.from(sets.keys())) {
        if (matcher.test(key)) {
          sets.delete(key);
          deleted++;
        }
      }
      return deleted;
    }),
    scan: jest.fn(async (pattern: string, _count?: number) => {
      const matcher = globToRegExp(pattern);
      return [...Array.from(store.keys()), ...Array.from(sets.keys())].filter(key => matcher.test(key));
    }),
  };
}
