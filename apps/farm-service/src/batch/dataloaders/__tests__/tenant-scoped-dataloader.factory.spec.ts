/**
 * Unit spec for the shared tenant-scoped DataLoader factory
 * (`@aquaculture/backend-common/dataloader`).
 *
 * The factory is the tier-1 guarantee behind FARM-MEDIUM-076: a batch function
 * cannot be constructed without receiving the resolved tenantId, and when no
 * tenant is in the request context the loader fails closed instead of running a
 * tenant-blind batch. This spec lives in farm-service (alongside the loaders it
 * protects) so it runs in the farm unit gate, but it exercises only the shared
 * factory's public contract.
 */
import { requestContextStorage } from '@aquaculture/backend-common/logging';
import {
  createTenantScopedDataLoader,
  MissingTenantContextError,
} from '@aquaculture/backend-common/dataloader';

const TENANT_A = '550e8400-e29b-41d4-a716-446655440000';

describe('createTenantScopedDataLoader', () => {
  describe('with a tenant in the request context', () => {
    it('hands the batch fn the resolved tenantId', async () => {
      const seenTenantIds: string[] = [];
      const loader = createTenantScopedDataLoader<string, string>(
        async (tenantId: string, keys: readonly string[]): Promise<string[]> => {
          seenTenantIds.push(tenantId);
          return keys.map((k) => `${tenantId}:${k}`);
        },
      );

      const result = await requestContextStorage.run({ tenantId: TENANT_A }, async () =>
        loader.load('k1'),
      );

      expect(seenTenantIds).toEqual([TENANT_A]);
      expect(result).toBe(`${TENANT_A}:k1`);
    });

    it('batches all keys loaded in the same tick into ONE batch fn call', async () => {
      let batchCalls = 0;
      let keysSeen: readonly string[] = [];
      const loader = createTenantScopedDataLoader<string, string>(
        async (tenantId: string, keys: readonly string[]): Promise<string[]> => {
          batchCalls += 1;
          keysSeen = keys;
          return keys.map((k) => `${tenantId}:${k}`);
        },
      );

      const results = await requestContextStorage.run({ tenantId: TENANT_A }, async () =>
        Promise.all([loader.load('a'), loader.load('b'), loader.load('c')]),
      );

      expect(batchCalls).toBe(1);
      expect(keysSeen).toEqual(['a', 'b', 'c']);
      expect(results).toEqual([`${TENANT_A}:a`, `${TENANT_A}:b`, `${TENANT_A}:c`]);
    });

    it('serves a repeated key from the per-loader cache (cache behavior preserved)', async () => {
      let batchCalls = 0;
      const loader = createTenantScopedDataLoader<string, string>(
        async (tenantId: string, keys: readonly string[]): Promise<string[]> => {
          batchCalls += 1;
          return keys.map((k) => `${tenantId}:${k}`);
        },
      );

      await requestContextStorage.run({ tenantId: TENANT_A }, async () => {
        const first = await loader.load('same');
        const second = await loader.load('same');
        expect(first).toBe(second);
      });

      // One batch for the first load; the second is a cache hit — no new batch.
      expect(batchCalls).toBe(1);
    });

    it('passes DataLoader options through (maxBatchSize splits the batch)', async () => {
      const batchSizes: number[] = [];
      const loader = createTenantScopedDataLoader<string, string>(
        async (tenantId: string, keys: readonly string[]): Promise<string[]> => {
          batchSizes.push(keys.length);
          return keys.map((k) => `${tenantId}:${k}`);
        },
        { dataLoaderOptions: { maxBatchSize: 2 } },
      );

      await requestContextStorage.run({ tenantId: TENANT_A }, async () =>
        Promise.all([loader.load('1'), loader.load('2'), loader.load('3')]),
      );

      // 3 keys, maxBatchSize 2 -> two batch fn calls of sizes 2 and 1.
      expect(batchSizes).toEqual([2, 1]);
    });
  });

  describe('with NO tenant in the request context (fail-closed)', () => {
    it('rejects with MissingTenantContextError and never calls the batch fn', async () => {
      let batchFnCalled = false;
      const loader = createTenantScopedDataLoader<string, string>(
        async (tenantId: string, keys: readonly string[]): Promise<string[]> => {
          batchFnCalled = true;
          return keys.map((k) => `${tenantId}:${k}`);
        },
      );

      // No requestContextStorage.run wrapper -> getRequestContext() is empty.
      await expect(loader.load('orphan')).rejects.toBeInstanceOf(MissingTenantContextError);
      expect(batchFnCalled).toBe(false);
    });

    it('fails closed when the context frame carries an empty-string tenantId', async () => {
      let batchFnCalled = false;
      const loader = createTenantScopedDataLoader<string, string>(
        async (tenantId: string, keys: readonly string[]): Promise<string[]> => {
          batchFnCalled = true;
          return keys.map((k) => `${tenantId}:${k}`);
        },
      );

      await requestContextStorage.run({ tenantId: '' }, async () => {
        await expect(loader.load('orphan')).rejects.toBeInstanceOf(MissingTenantContextError);
      });

      expect(batchFnCalled).toBe(false);
    });

    it('includes the loader label in the error message for diagnostics', async () => {
      const loader = createTenantScopedDataLoader<string, string>(
        async (tenantId: string, keys: readonly string[]): Promise<string[]> =>
          keys.map((k) => `${tenantId}:${k}`),
        { batchFnName: 'WidgetDataLoader' },
      );

      await expect(loader.load('orphan')).rejects.toThrow('WidgetDataLoader');
    });

    it('does NOT embed the raw tenant id in the error (PII discipline)', () => {
      const error = new MissingTenantContextError('WidgetDataLoader');
      expect(error.message).not.toContain(TENANT_A);
      expect(error.state).toBe('TENANT_CONTEXT_MISSING');
    });
  });
});
