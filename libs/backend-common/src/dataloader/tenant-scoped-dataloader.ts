/**
 * Tenant-scoped DataLoader factory (tier-1: make the wrong shape impossible).
 *
 * Background: per-request DataLoaders that batch rows across many keys MUST
 * constrain every batched query to the current tenant. Adding the tenant filter
 * by hand in each loader's batch function (FARM-MEDIUM-076) is correct but
 * REPEATABLE-WRONG: nothing stops the next loader from omitting it, silently
 * batch-leaking another tenant's rows through a pooled connection.
 *
 * This factory removes that failure mode structurally. The batch function it
 * accepts CANNOT be written without receiving the resolved `tenantId` — it is
 * the first, required positional parameter of {@link TenantScopedBatchFn}. The
 * factory itself is the ONLY place that produces that value, and it resolves it
 * from the request context fail-closed: if no tenant is in scope, no batch runs
 * and a {@link MissingTenantContextError} is thrown instead of a tenant-blind
 * query. There is no code path through which a caller can construct a loader
 * whose batch function does not receive (and therefore use) the tenant id.
 *
 * Scope: the returned DataLoader is per-request by construction — callers create
 * one inside a request-scoped provider or per-request GraphQL context so its
 * cache never crosses requests.
 *
 * @module Dataloader
 */
import DataLoader from 'dataloader';

import { getRequestContext } from '../logging';

/**
 * Thrown when a tenant-scoped DataLoader's batch tick fires with no tenant in
 * the request context. Converts a would-be tenant-blind batch query into a
 * hard, observable failure instead of a silent cross-tenant read.
 *
 * The raw tenant id is never embedded in error state — tenant id is a tenant
 * label, not a diagnostic value (consistent with the platform PII-masking
 * convention). Absence is the only signal this error needs to carry.
 */
export class MissingTenantContextError extends Error {
  readonly state = 'TENANT_CONTEXT_MISSING' as const;

  constructor(loaderName?: string) {
    super(
      `Tenant-scoped DataLoader${loaderName ? ` "${loaderName}"` : ''} ` +
        `refused to batch: no tenant id is present in the request context. ` +
        `Refusing to run a tenant-blind batch query.`,
    );
    this.name = 'MissingTenantContextError';
  }
}

/**
 * The batch function a caller supplies to {@link createTenantScopedDataLoader}.
 *
 * `tenantId` is the first, REQUIRED parameter and is guaranteed non-empty by the
 * factory — this is the structural guarantee that the tenant filter can never be
 * forgotten. Implementations apply it to every query they issue.
 *
 * Like a vanilla DataLoader batch function, it returns one entry per input key,
 * in the same order, each either a value `V` or an `Error` for that key.
 */
export type TenantScopedBatchFn<K, V> = (
  tenantId: string,
  keys: readonly K[],
) => Promise<ArrayLike<V | Error>>;

/**
 * Options for {@link createTenantScopedDataLoader}.
 *
 * `batchFnName` is an optional label surfaced in {@link MissingTenantContextError}
 * for diagnostics. `dataLoaderOptions` are passed straight through to the
 * underlying DataLoader so callers preserve their exact batching/cache semantics
 * (`cache`, `maxBatchSize`, `batchScheduleFn`, `cacheKeyFn`, ...). The batch
 * function is fixed by this factory, so it is intentionally not configurable here.
 */
export interface TenantScopedDataLoaderOptions<K, V> {
  readonly batchFnName?: string;
  readonly dataLoaderOptions?: DataLoader.Options<K, V>;
}

/**
 * Create a per-request DataLoader whose batch function is guaranteed to receive
 * a resolved, non-empty tenant id sourced from the request context.
 *
 * Fail-closed: if the batch tick fires with no tenant in context, the loader
 * throws {@link MissingTenantContextError} rather than issuing a tenant-blind
 * query. The tenant id is resolved at batch-tick time (not at construction time)
 * so the loader always reflects the tenant of the request whose async frame is
 * actually executing the batch.
 *
 * @typeParam K - the load key type (e.g. a batch id)
 * @typeParam V - the value type returned per key (e.g. `Row[]` or `Row | null`)
 */
export function createTenantScopedDataLoader<K, V>(
  batchFn: TenantScopedBatchFn<K, V>,
  options?: TenantScopedDataLoaderOptions<K, V>,
): DataLoader<K, V> {
  return new DataLoader<K, V>(async (keys: readonly K[]): Promise<ArrayLike<V | Error>> => {
    const tenantId = getRequestContext().tenantId;
    if (tenantId === undefined || tenantId === '') {
      throw new MissingTenantContextError(options?.batchFnName);
    }
    return batchFn(tenantId, keys);
  }, options?.dataLoaderOptions);
}
