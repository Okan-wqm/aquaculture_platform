/**
 * The ONE list of client caches that read the storage ledger or open purchase
 * orders (plan K8, FARM-HIGH-338).
 *
 * WHY: spare-part quantity/status and the pool low-stock rows are now DERIVED
 * from the ledger and from open purchase-order lines, and feed/chemical/
 * consumable stock is a projection of the same ledger. Each writer used to list
 * the caches it remembered, so a delivery or a storage movement left the
 * spare-part lists stale. Every ledger or purchase-order writer calls this one
 * function instead.
 */
import type { QueryClient } from '@tanstack/react-query';
import { createTenantInvalidationKey } from '@aquaculture/shared-ui';

const STOCK_READ_MODELS: ReadonlyArray<readonly string[]> = [
  ['storageInventory'],
  ['stockMovements'],
  ['storageOverview'],
  ['feeds', 'list'],
  ['chemicals', 'list'],
  ['consumables', 'list'],
  ['spareParts'],
  ['sparePart'],
  ['lowStockAlerts'],
  ['stockSummary'],
];

/** Invalidate every ledger-derived cache of the tenant; resolves when all are marked. */
export async function invalidateStockReadModels(
  queryClient: QueryClient,
  tenantId: string | null | undefined,
): Promise<void> {
  await Promise.all(
    STOCK_READ_MODELS.map((segments) =>
      queryClient.invalidateQueries({
        queryKey: createTenantInvalidationKey(tenantId, ...segments),
      }),
    ),
  );
}
