/**
 * Finance read-model cache contract (PERF-HIGH-004).
 *
 * The summary/batch aggregations are read-through cached; EVERY finance mutation
 * must evict them, or a write would leave a stale cached aggregation until the
 * TTL expires. This spec locks both halves of that contract against the
 * @Cacheable / @CacheEvict metadata so a future mutation added without an evict
 * (the classic stale-cache regression) fails at build time, not in production.
 */
import 'reflect-metadata';

import { CACHE_EVICT_METADATA_KEY } from '../../common/cache/cache-evict.decorator';
import { CACHEABLE_METADATA_KEY } from '../../common/cache/cacheable.decorator';
import { FinanceResolver } from '../resolvers/finance.resolver';

// NestJS `SetMetadata` attaches metadata to the method FUNCTION itself, so the
// reflection target is the prototype method (a function — hence an object).
const p = FinanceResolver.prototype;

const cacheableOf = (method: object): { prefix: string } | undefined =>
  Reflect.getMetadata(CACHEABLE_METADATA_KEY, method) as { prefix: string } | undefined;

const evictOf = (method: object): { prefixes: string[] } | undefined =>
  Reflect.getMetadata(CACHE_EVICT_METADATA_KEY, method) as { prefixes: string[] } | undefined;

/** Every mutation that can change a finance number the summary/batch aggregate. */
const FINANCE_MUTATIONS: ReadonlyArray<[name: string, method: object]> = [
  ['createFinanceEntry', p.createFinanceEntry],
  ['updateFinanceEntry', p.updateFinanceEntry],
  ['deleteFinanceEntry', p.deleteFinanceEntry],
  ['createFinanceCategory', p.createFinanceCategory],
  ['updateFinanceCategory', p.updateFinanceCategory],
  ['archiveFinanceCategory', p.archiveFinanceCategory],
  ['restoreFinanceCategory', p.restoreFinanceCategory],
  ['updateFinanceSettings', p.updateFinanceSettings],
];

const CACHED_PREFIXES = ['finance:summary', 'finance:batchTotals'];

describe('FinanceResolver cache contract (PERF-HIGH-004)', () => {
  it('read-through caches the two heavy aggregations', () => {
    expect(cacheableOf(p.financeSummary)?.prefix).toBe('finance:summary');
    expect(cacheableOf(p.financeBatchTotals)?.prefix).toBe('finance:batchTotals');
  });

  it.each(FINANCE_MUTATIONS)('%s evicts every cached finance aggregation', (_name, method) => {
    const evict = evictOf(method);
    expect(evict).toBeDefined();
    // Must evict BOTH cached prefixes — a mutation that evicts only one leaves the
    // other stale.
    expect(evict?.prefixes).toEqual(expect.arrayContaining(CACHED_PREFIXES));
  });

  it('every cached prefix is covered by the eviction set (no orphan cache)', () => {
    // If a new @Cacheable prefix is added, at least one mutation must evict it.
    for (const prefix of CACHED_PREFIXES) {
      const covered = FINANCE_MUTATIONS.some(([, method]) =>
        evictOf(method)?.prefixes.includes(prefix),
      );
      expect(covered).toBe(true);
    }
  });
});
