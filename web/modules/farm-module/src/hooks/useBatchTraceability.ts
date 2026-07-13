/**
 * Batch traceability hook for farm-module
 *
 * WHY: the Traceability tab on BatchDetailPage renders the full lifecycle
 * report for one batch (residency intervals, per-tank water/feed aggregates,
 * whole-batch feed totals and the operation timeline). The backend already
 * serves this as the federated `batchTraceability` query (farm-service,
 * Phase 6) — this hook is the module's single read path for it.
 *
 * WHAT: uses the shared `useTenantQuery` (tenant-prefixed key + auth gate)
 * with the federated `batchTraceability` query through farm-module's shared
 * graphqlClient, so the report is cache-isolated per tenant.
 */
import { useTenantQuery, graphqlClient } from '@aquaculture/shared-ui';

/**
 * Whole-batch header of the report. Dates arrive as ISO strings over the
 * GraphQL transport; nullable backend fields are typed `| null` because the
 * wire shape returns explicit nulls for selected-but-empty fields.
 */
export interface BatchTraceabilitySummary {
  batchId: string;
  batchNumber: string;
  status: string;
  speciesName: string | null;
  stockedAt: string;
  harvestedAt: string | null;
  daysInProduction: number;
  initialQuantity: number;
  currentQuantity: number;
  initialAvgWeightG: number | null;
  currentAvgWeightG: number | null;
  survivalRatePercent: number | null;
  protocolId: string | null;
  protocolName: string | null;
  totalFeedKg: number;
  /** @deprecated Float — use `totalFeedCostDecimal` (exact decimal string, ADR-0004). */
  totalFeedCost: number | null;
  totalFeedCostDecimal: string | null;
  fcrActual: number | null;
}

/** Water-temperature aggregate for one residency interval. */
export interface BatchResidencyWaterSummary {
  temperatureMinC: number | null;
  temperatureAvgC: number | null;
  temperatureMaxC: number | null;
  measurementCount: number;
}

/** Per-feed consumption aggregate (per residency AND whole-batch totals). */
export interface BatchFeedTotal {
  feedId: string;
  feedName: string | null;
  feedCode: string | null;
  totalKg: number;
  /** @deprecated Float — use `totalCostDecimal` (exact decimal string, ADR-0004). */
  totalCost: number | null;
  totalCostDecimal: string | null;
}

/** One "where the fish lived" interval: a tank stay with its aggregates. */
export interface BatchResidency {
  tankId: string;
  tankName: string | null;
  tankCode: string | null;
  movedAt: string;
  exitedAt: string | null;
  isCurrent: boolean;
  durationDays: number;
  quantityAtEntry: number;
  avgWeightAtEntryG: number | null;
  transferReason: string | null;
  water: BatchResidencyWaterSummary;
  feed: BatchFeedTotal[];
  feedTotalKg: number;
}

/**
 * One operation-timeline entry (shared shape with `batchHistory`).
 * `eventType` carries the GraphQL enum KEY (UPPERCASE, e.g. 'MORTALITY').
 */
export interface BatchTraceabilityEvent {
  id: string;
  eventType: string;
  timestamp: string;
  description: string;
  performedBy: string | null;
  tankId: string | null;
  tankCode: string | null;
  quantityChange: number | null;
  biomassChangeKg: number | null;
}

/** Full `batchTraceability` response. */
export interface BatchTraceability {
  summary: BatchTraceabilitySummary;
  residencies: BatchResidency[];
  feedTotals: BatchFeedTotal[];
  events: BatchTraceabilityEvent[];
}

// Federated `batchTraceability` query (farm-service). Field selection mirrors
// BatchTraceabilityResponse (apps/farm-service/src/batch/dto/batch-traceability.response.ts)
// minus the `details` JSON blob on events — the tab renders the description line.
const BATCH_TRACEABILITY_QUERY = `
  query BatchTraceability($id: ID!) {
    batchTraceability(id: $id) {
      summary {
        batchId
        batchNumber
        status
        speciesName
        stockedAt
        harvestedAt
        daysInProduction
        initialQuantity
        currentQuantity
        initialAvgWeightG
        currentAvgWeightG
        survivalRatePercent
        protocolId
        protocolName
        totalFeedKg
        totalFeedCost
        totalFeedCostDecimal
        fcrActual
      }
      residencies {
        tankId
        tankName
        tankCode
        movedAt
        exitedAt
        isCurrent
        durationDays
        quantityAtEntry
        avgWeightAtEntryG
        transferReason
        water {
          temperatureMinC
          temperatureAvgC
          temperatureMaxC
          measurementCount
        }
        feed {
          feedId
          feedName
          feedCode
          totalKg
          totalCost
          totalCostDecimal
        }
        feedTotalKg
      }
      feedTotals {
        feedId
        feedName
        feedCode
        totalKg
        totalCost
        totalCostDecimal
      }
      events {
        id
        eventType
        timestamp
        description
        performedBy
        tankId
        tankCode
        quantityChange
        biomassChangeKg
      }
    }
  }
`;

export interface UseBatchTraceabilityResult {
  traceability: BatchTraceability | undefined;
  isLoading: boolean;
  error: Error | null;
}

/**
 * Fetch the full traceability report for one batch. Disabled until a batch id
 * is present so the tab never fires an empty-id query while the route settles.
 */
export function useBatchTraceability(batchId: string): UseBatchTraceabilityResult {
  const { data, isLoading, error } = useTenantQuery<BatchTraceability>(
    ['batches', batchId, 'traceability'],
    async (): Promise<BatchTraceability> => {
      const result = await graphqlClient.request<{ batchTraceability: BatchTraceability }>(
        BATCH_TRACEABILITY_QUERY,
        { id: batchId },
      );
      return result.batchTraceability;
    },
    { enabled: batchId.length > 0, staleTime: 30000 },
  );

  return {
    traceability: data,
    isLoading,
    error: error ?? null,
  };
}
