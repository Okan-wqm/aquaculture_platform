import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { gql } from 'graphql-tag';

import { useAuth } from './useAuth';

import { cacheData, getCachedData } from '@/pwa/offline-queue';
import { graphqlRequest } from '@/services/authenticated-fetch';
import type { Tank } from '@/types';
import { logger } from '@/utils/logger';
import { createTenantQueryKey } from '@/utils/tenant-query-keys';

// tenantId comes from X-Tenant-Id header (extracted from JWT by backend)
const TANK_PAGE_SIZE = 100;

const FARM_STOCK_INVENTORY_QUERY = gql`
  query FarmStockInventory($filter: FarmStockInventoryFilterInput) {
    farmStockInventory(filter: $filter) {
      items {
        container {
          containerId
          name
          code
          volume
          status
          siteId
          currentQuantity
          currentBiomassKg
          maxBiomassKg
          capacityUsedPercent
          isOverCapacity
        }
        batches {
          batchId
          batchNumber
          speciesId
          speciesName
          quantity
          avgWeightG
          biomassKg
          densityKgM3
          isPrimary
        }
      }
      total
    }
  }
`;

interface FarmStockInventoryResult {
  farmStockInventory: {
    items: Array<{
      container: {
        containerId: string;
        name: string;
        code: string;
        volume: number | null;
        status: string | null;
        siteId: string | null;
        currentQuantity: number | null;
        currentBiomassKg: number | null;
        maxBiomassKg: number | null;
        capacityUsedPercent: number | null;
        isOverCapacity: boolean;
      };
      batches: Array<{
        batchId: string;
        batchNumber: string | null;
        speciesId: string | null;
        speciesName: string | null;
        quantity: number;
        avgWeightG: number;
        biomassKg: number;
        densityKgM3: number | null;
        isPrimary: boolean;
      }>;
    }>;
    total: number;
  };
}

/**
 * The eight members of the backend `TankStatus` enum, as a runtime set.
 *
 * ORPHAN-HIGH-583: the wire type for this field is a free-form String, and this
 * mapper used to force it into the union with `as Tank['status']`. When the
 * frontend union was missing CLEANING and FALLOW, a fallowing pen — routine
 * between production cycles — reached the render tree as a status no lookup
 * table had, and the unit detail crashed on `STATUS_META[tank.status].tone`.
 *
 * Completing the union fixed that crash; this removes the mechanism that let
 * wire drift reach the render tree at all. A cast asserts; this checks.
 */
const TANK_STATUSES: ReadonlySet<string> = new Set<Tank['status']>([
  'ACTIVE',
  'PREPARING',
  'CLEANING',
  'MAINTENANCE',
  'HARVESTING',
  'FALLOW',
  'QUARANTINE',
  'INACTIVE',
]);

/**
 * Narrow the wire value, or fall back loudly.
 *
 * A status the frontend does not know means the backend enum grew and this app
 * has not caught up — a real event that should be visible, not a silent
 * default. INACTIVE is the safe landing: it renders, it reads as "not in
 * production", and it never implies a pen is stocked and healthy.
 */
export function narrowTankStatus(raw: string | null | undefined): Tank['status'] {
  if (raw == null) return 'ACTIVE';
  const upper = raw.toUpperCase();
  if (TANK_STATUSES.has(upper)) return upper as Tank['status'];
  logger.warn('[useTanks] unknown container status from the wire', { status: raw });
  return 'INACTIVE';
}

function mapInventoryItemToTank(
  item: FarmStockInventoryResult['farmStockInventory']['items'][number],
): Tank {
  // FARM-LOW-216: the container's PRIMARY batch drives species/batch
  // attribution for field capture. Prefer the explicit isPrimary row (the
  // tank-composition ledger's primaryBatchId, projected into the snapshot);
  // the [0] fallback covers pre-migration snapshots, where the handler's
  // isPrimary-first ordering already puts the primary at the head.
  const primaryBatch = item.batches.find((b) => b.isPrimary) ?? item.batches[0];
  return {
    id: item.container.containerId,
    name: item.container.name,
    code: item.container.code,
    volume: item.container.volume ?? 0,
    status: narrowTankStatus(item.container.status),
    // The container's OWN totals, across every batch in it. These are what
    // unit- and farm-level figures must use; the per-batch block below covers
    // only the primary batch and understates a mixed pen.
    currentQuantity: item.container.currentQuantity ?? 0,
    currentBiomass: item.container.currentBiomassKg ?? 0,
    maxBiomass: item.container.maxBiomassKg ?? 0,
    siteId: item.container.siteId,
    batchMetrics: primaryBatch
      ? {
          batchId: primaryBatch.batchId,
          batchNumber: primaryBatch.batchNumber,
          speciesId: primaryBatch.speciesId,
          speciesName: primaryBatch.speciesName,
          pieces: primaryBatch.quantity,
          avgWeight: primaryBatch.avgWeightG,
          biomass: primaryBatch.biomassKg,
          density: primaryBatch.densityKgM3,
          capacityUsedPercent: item.container.capacityUsedPercent,
          isOverCapacity: item.container.isOverCapacity,
          daysSinceStocking: null,
        }
      : null,
  };
}

async function fetchTanksPage(page: number): Promise<{ items: Tank[]; total: number }> {
  const result = await graphqlRequest<FarmStockInventoryResult>(FARM_STOCK_INVENTORY_QUERY, {
    filter: {
      page,
      limit: TANK_PAGE_SIZE,
      isActive: true,
    },
  });

  if (!result.farmStockInventory?.items) {
    throw new Error('Invalid response: no farm stock inventory data');
  }

  return {
    items: result.farmStockInventory.items.map(mapInventoryItemToTank),
    total: result.farmStockInventory.total,
  };
}

export async function fetchAllTanks(): Promise<Tank[]> {
  const tanks: Tank[] = [];
  let total = Number.POSITIVE_INFINITY;

  // WHY: farm-service paginates `tanks` with a default limit of 20 and a max
  // limit of 100. Mobile home/detail/action screens need the complete tenant
  // tank set; otherwise rows that exist in the tenant schema never appear.
  while (tanks.length < total) {
    const page = await fetchTanksPage(Math.floor(tanks.length / TANK_PAGE_SIZE) + 1);
    total = page.total;

    if (page.items.length === 0 && tanks.length < total) {
      throw new Error(`Invalid response: tanks pagination stopped at ${tanks.length} of ${total}`);
    }

    tanks.push(...page.items);
  }

  return tanks;
}

export function useTanks(): UseQueryResult<Tank[], Error> {
  const { accessToken, tenantId, isAuthenticated } = useAuth();

  return useQuery({
    queryKey: createTenantQueryKey(tenantId, 'tanks', tenantId),
    queryFn: async () => {
      if (!accessToken || !tenantId) {
        throw new Error('Not authenticated');
      }

      try {
        const tanks = await fetchAllTanks();
        // PERF-05: Write to IndexedDB only as an offline fallback.
        // React Query's own gcTime handles in-memory caching for the online path,
        // eliminating the duplicate cache layer.
        // SECURITY (FE-CRITICAL-002): tenantId required for tenant-isolated caching
        await cacheData(tenantId, 'tanks', tanks, 1000 * 60 * 60); // 1 hour TTL for offline use
        return tanks;
      } catch (error) {
        // Network failed — return IndexedDB cached data if available
        const cached = await getCachedData<Tank[]>(tenantId, 'tanks');
        if (cached) {
          return cached;
        }
        throw error;
      }
    },
    enabled: isAuthenticated && !!tenantId,
    staleTime: 1000 * 60 * 1, // 1 minute — more accurate for live inventory data
    gcTime: 1000 * 60 * 60, // 1 hour in-memory retention
    refetchOnWindowFocus: true, // refresh tank data when returning to the app
  });
}
