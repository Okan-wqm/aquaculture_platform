/**
 * PURE projections for the farm-stock farm-AI responder (PR-5, Operations
 * specialist). Covers the live farm-stock inventory (container + batch
 * snapshots).
 *
 * Rules of the read-only namespace (see common/nats/ai-query-responder.ts):
 *  - Input = the query handler's return shape; output = wire DTO ONLY.
 *  - NO entity metadata (createdAt/updatedAt/tenantId) — snapshots are
 *    projection state, already PII-free; identity + numbers cross the wire.
 *  - Dates → ISO strings (or null); numbers keep their unit in the name.
 */
import { FarmStockContainerSnapshot } from '../entities/farm-stock-container-snapshot.entity';
import { FarmStockBatchSnapshot } from '../entities/farm-stock-batch-snapshot.entity';
import { isoOrNull } from '../../common/nats/ai-query-responder';

/** One batch living in a container (primary batch first — handler orders). */
export interface StockBatchDto {
  batchId: string;
  batchNumber: string | null;
  batchStatus: string | null;
  speciesId: string | null;
  speciesName: string | null;
  quantity: number;
  biomassKg: number;
  avgWeightG: number;
  densityKgM3: number | null;
  isPrimary: boolean;
}

/** One container with its current stock numbers and batches. */
export interface StockContainerDto {
  containerId: string;
  containerSource: string;
  name: string;
  code: string;
  siteId: string | null;
  departmentId: string | null;
  status: string | null;
  volumeM3: number | null;
  maxBiomassKg: number | null;
  currentQuantity: number | null;
  currentBiomassKg: number | null;
  capacityUsedPercent: number | null;
  isOverCapacity: boolean;
  hasActiveBatch: boolean;
  isActive: boolean;
  lastStockEventAt: string | null;
  batches: StockBatchDto[];
}

function projectBatch(batch: FarmStockBatchSnapshot): StockBatchDto {
  return {
    batchId: batch.batchId,
    batchNumber: batch.batchNumber ?? null,
    batchStatus: batch.batchStatus ?? null,
    speciesId: batch.speciesId ?? null,
    speciesName: batch.speciesName ?? null,
    quantity: batch.quantity,
    biomassKg: batch.biomassKg,
    avgWeightG: batch.avgWeightG,
    densityKgM3: batch.densityKgM3 ?? null,
    isPrimary: batch.isPrimary === true,
  };
}

/** Project a container snapshot with its batch snapshots. */
export function projectStockContainer(
  container: FarmStockContainerSnapshot,
  batches: FarmStockBatchSnapshot[],
): StockContainerDto {
  return {
    containerId: container.containerId,
    containerSource: String(container.containerSource),
    name: container.name,
    code: container.code,
    siteId: container.siteId ?? null,
    departmentId: container.departmentId ?? null,
    status: container.status ?? null,
    volumeM3: container.volume ?? null,
    maxBiomassKg: container.maxBiomassKg ?? null,
    currentQuantity: container.currentQuantity ?? null,
    currentBiomassKg: container.currentBiomassKg ?? null,
    capacityUsedPercent: container.capacityUsedPercent ?? null,
    isOverCapacity: container.isOverCapacity === true,
    hasActiveBatch: container.hasActiveBatch === true,
    isActive: container.isActive === true,
    lastStockEventAt: isoOrNull(container.lastStockEventAt),
    batches: batches.map(projectBatch),
  };
}
