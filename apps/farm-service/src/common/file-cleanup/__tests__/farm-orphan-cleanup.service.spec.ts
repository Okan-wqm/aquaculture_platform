/**
 * FarmOrphanCleanupService Unit Tests
 *
 * Covers the aggregation logic:
 *   - unions live paths from every provider
 *   - forwards the union + options to StorageOrphanCleanupService
 *   - fails closed when a provider throws — the cleanup is NOT
 *     invoked (protecting live files that the broken provider
 *     would have claimed)
 *   - per-provider livePathCount appears in the summary
 *   - startedAt is set and cleanup options pass through
 */
import { FarmOrphanCleanupService } from '../farm-orphan-cleanup.service';
import { FileReferenceProvider } from '../file-reference-provider';

function makeProvider(
  name: string,
  paths: string[] | Error,
): FileReferenceProvider {
  return {
    name,
    collectLivePaths: jest
      .fn()
      .mockImplementation(async () => {
        if (paths instanceof Error) throw paths;
        return paths;
      }),
  };
}

function makeCleanup() {
  const cleanup = jest.fn().mockResolvedValue({
    totalScanned: 5,
    live: 3,
    deleted: 1,
    tooNew: 1,
    capped: false,
    errors: [],
    durationMs: 42,
  });
  return { cleanup: { cleanup } as unknown as import('@platform/storage').StorageOrphanCleanupService, spy: cleanup };
}

describe('FarmOrphanCleanupService', () => {
  it('unions live paths from every provider', async () => {
    const { cleanup, spy } = makeCleanup();
    const svc = new FarmOrphanCleanupService(
      cleanup,
      [
        makeProvider('A', ['p1', 'p2']),
        makeProvider('B', ['p2', 'p3']),
      ],
    );
    await svc.run();
    expect(spy).toHaveBeenCalledTimes(1);
    const call = spy.mock.calls[0]![0] as { livePaths: Set<string> };
    expect([...call.livePaths].sort()).toEqual(['p1', 'p2', 'p3']);
  });

  it('summary includes per-provider livePathCount', async () => {
    const { cleanup } = makeCleanup();
    const svc = new FarmOrphanCleanupService(
      cleanup,
      [
        makeProvider('BatchDocument', ['x', 'y']),
        makeProvider('Chemical', ['z']),
      ],
    );
    const summary = await svc.run();
    expect(summary.providersUsed).toEqual([
      { name: 'BatchDocument', livePathCount: 2 },
      { name: 'Chemical', livePathCount: 1 },
    ]);
    expect(typeof summary.startedAt).toBe('string');
    expect(summary.totalScanned).toBe(5);
    expect(summary.deleted).toBe(1);
  });

  it('forwards prefix / minAgeMs / maxDeletions to the cleanup', async () => {
    const { cleanup, spy } = makeCleanup();
    const svc = new FarmOrphanCleanupService(cleanup, [
      makeProvider('A', []),
    ]);
    await svc.run({ prefix: 'tenant-1/', minAgeMs: 1000, maxDeletions: 5 });
    const call = spy.mock.calls[0]![0] as {
      prefix?: string;
      minAgeMs?: number;
      maxDeletions?: number;
    };
    expect(call.prefix).toBe('tenant-1/');
    expect(call.minAgeMs).toBe(1000);
    expect(call.maxDeletions).toBe(5);
  });

  it('fails closed when a provider throws — cleanup NOT invoked', async () => {
    const { cleanup, spy } = makeCleanup();
    const svc = new FarmOrphanCleanupService(
      cleanup,
      [
        makeProvider('Good', ['p1']),
        makeProvider('Broken', new Error('db-down')),
        makeProvider('NeverCalled', ['p2']),
      ],
    );
    const summary = await svc.run();
    // CRITICAL invariant: cleanup is NOT invoked when any
    // provider errors. Running with a partial live-paths set
    // would delete files the broken provider would have claimed.
    expect(spy).not.toHaveBeenCalled();
    expect(summary.deleted).toBe(0);
    expect(summary.errors).toHaveLength(1);
    expect(summary.errors[0]!.path).toBe('provider:Broken');
    expect(summary.errors[0]!.error).toContain('db-down');
    // The broken provider appears in the summary with livePathCount=-1
    const broken = summary.providersUsed.find((p) => p.name === 'Broken');
    expect(broken?.livePathCount).toBe(-1);
  });

  it('empty provider list still runs (cleans every orphan older than threshold)', async () => {
    const { cleanup, spy } = makeCleanup();
    const svc = new FarmOrphanCleanupService(cleanup, []);
    const summary = await svc.run();
    expect(spy).toHaveBeenCalledTimes(1);
    const call = spy.mock.calls[0]![0] as { livePaths: Set<string> };
    expect(call.livePaths.size).toBe(0);
    expect(summary.providersUsed).toEqual([]);
  });
});
