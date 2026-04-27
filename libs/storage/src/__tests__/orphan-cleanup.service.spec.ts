/**
 * StorageOrphanCleanupService Unit Tests
 *
 * Covers the generic cleanup loop with a MinIO double:
 *   - returns correct shape on empty bucket
 *   - live-set objects are never deleted
 *   - too-new objects are skipped regardless of live status
 *   - age-gated orphans are deleted
 *   - maxDeletions caps the loop + flags `capped: true`
 *   - per-object delete errors land in `errors` without throwing
 *   - prefix is forwarded to `listObjects`
 */
import {
  StorageOrphanCleanupService,
} from '../orphan-cleanup.service';

interface BucketObject {
  name: string;
  size: number;
  lastModified: Date;
}

function minutesAgo(n: number): Date {
  return new Date(Date.now() - n * 60 * 1000);
}

function daysAgo(n: number): Date {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000);
}

function makeClient(opts: {
  objects: BucketObject[];
  failingDeletes?: Set<string>;
}) {
  const deleted: string[] = [];
  const listObjects = jest.fn().mockImplementation(async (_prefix: string) => [
    ...opts.objects,
  ]);
  const deleteFile = jest.fn().mockImplementation(async (path: string) => {
    if (opts.failingDeletes?.has(path)) {
      throw new Error(`boom-${path}`);
    }
    deleted.push(path);
  });
  return {
    client: { listObjects, deleteFile } as unknown as import('../minio-client.service').MinioClientService,
    listObjects,
    deleteFile,
    deleted,
  };
}

describe('StorageOrphanCleanupService', () => {
  it('empty bucket returns zero counts and empty errors', async () => {
    const { client } = makeClient({ objects: [] });
    const svc = new StorageOrphanCleanupService(client);
    const result = await svc.cleanup({ livePaths: new Set() });
    expect(result.totalScanned).toBe(0);
    expect(result.live).toBe(0);
    expect(result.deleted).toBe(0);
    expect(result.tooNew).toBe(0);
    expect(result.capped).toBe(false);
    expect(result.errors).toEqual([]);
    expect(typeof result.durationMs).toBe('number');
  });

  it('live-set objects are kept even when older than minAgeMs', async () => {
    const live = 'tenant-1/batch/doc-a.pdf';
    const { client, deleteFile } = makeClient({
      objects: [{ name: live, size: 100, lastModified: daysAgo(30) }],
    });
    const svc = new StorageOrphanCleanupService(client);
    const result = await svc.cleanup({ livePaths: new Set([live]) });
    expect(result.live).toBe(1);
    expect(result.deleted).toBe(0);
    expect(deleteFile).not.toHaveBeenCalled();
  });

  it('too-new orphans are skipped (protects in-flight uploads)', async () => {
    const { client, deleteFile } = makeClient({
      objects: [{ name: 'orphan.pdf', size: 100, lastModified: minutesAgo(30) }],
    });
    const svc = new StorageOrphanCleanupService(client);
    const result = await svc.cleanup({
      livePaths: new Set(),
      minAgeMs: 24 * 60 * 60 * 1000, // 24h default
    });
    expect(result.tooNew).toBe(1);
    expect(result.deleted).toBe(0);
    expect(deleteFile).not.toHaveBeenCalled();
  });

  it('age-gated orphans are deleted', async () => {
    const { client, deleteFile, deleted } = makeClient({
      objects: [
        { name: 'stale-1.pdf', size: 100, lastModified: daysAgo(5) },
        { name: 'stale-2.pdf', size: 200, lastModified: daysAgo(2) },
      ],
    });
    const svc = new StorageOrphanCleanupService(client);
    const result = await svc.cleanup({ livePaths: new Set() });
    expect(result.deleted).toBe(2);
    expect(result.live).toBe(0);
    expect(deleteFile).toHaveBeenCalledTimes(2);
    expect(deleted.sort()).toEqual(['stale-1.pdf', 'stale-2.pdf']);
  });

  it('maxDeletions caps the run and flags capped=true', async () => {
    const { client, deleteFile } = makeClient({
      objects: [
        { name: 'a', size: 1, lastModified: daysAgo(10) },
        { name: 'b', size: 1, lastModified: daysAgo(10) },
        { name: 'c', size: 1, lastModified: daysAgo(10) },
        { name: 'd', size: 1, lastModified: daysAgo(10) },
      ],
    });
    const svc = new StorageOrphanCleanupService(client);
    const result = await svc.cleanup({
      livePaths: new Set(),
      maxDeletions: 2,
    });
    expect(result.deleted).toBe(2);
    expect(result.capped).toBe(true);
    expect(deleteFile).toHaveBeenCalledTimes(2);
  });

  it('per-object delete errors are captured, not thrown', async () => {
    const { client } = makeClient({
      objects: [
        { name: 'ok-1', size: 1, lastModified: daysAgo(10) },
        { name: 'bad', size: 1, lastModified: daysAgo(10) },
        { name: 'ok-2', size: 1, lastModified: daysAgo(10) },
      ],
      failingDeletes: new Set(['bad']),
    });
    const svc = new StorageOrphanCleanupService(client);
    const result = await svc.cleanup({ livePaths: new Set() });
    expect(result.deleted).toBe(2);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.path).toBe('bad');
    expect(result.errors[0]!.error).toContain('boom-bad');
  });

  it('prefix is forwarded to listObjects', async () => {
    const { client, listObjects } = makeClient({ objects: [] });
    const svc = new StorageOrphanCleanupService(client);
    await svc.cleanup({ livePaths: new Set(), prefix: 'tenant-xyz/' });
    expect(listObjects).toHaveBeenCalledWith('tenant-xyz/');
  });

  it('mixed bucket: classifies every object into exactly one bucket', async () => {
    const liveName = 'live.pdf';
    const { client } = makeClient({
      objects: [
        { name: liveName, size: 1, lastModified: daysAgo(100) }, // live
        { name: 'stale.pdf', size: 1, lastModified: daysAgo(10) }, // delete
        { name: 'new.pdf', size: 1, lastModified: minutesAgo(10) }, // too-new
      ],
    });
    const svc = new StorageOrphanCleanupService(client);
    const result = await svc.cleanup({ livePaths: new Set([liveName]) });
    expect(result.totalScanned).toBe(3);
    expect(result.live).toBe(1);
    expect(result.deleted).toBe(1);
    expect(result.tooNew).toBe(1);
    expect(result.live + result.deleted + result.tooNew).toBe(result.totalScanned);
  });
});
