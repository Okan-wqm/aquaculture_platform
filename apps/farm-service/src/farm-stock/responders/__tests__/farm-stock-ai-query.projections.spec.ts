/**
 * Projection spec for the farm-stock farm-AI responder (PR-5): PII deep ban,
 * ISO dates.
 */
import { projectStockContainer } from '../projections';
import {
  FarmStockContainerSnapshot,
} from '../../entities/farm-stock-container-snapshot.entity';
import { FarmStockBatchSnapshot } from '../../entities/farm-stock-batch-snapshot.entity';

const BANNED_KEYS = [
  'reportedBy',
  'assignedTo',
  'createdBy',
  'completedBy',
  'approvedBy',
  'verifiedBy',
  'userId',
  'userName',
  'notes',
  'attachments',
  'specifications',
  'checklist',
  'tenantId',
  'createdAt',
  'updatedAt',
];

function collectKeys(value: unknown, into: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, into);
  } else if (typeof value === 'object' && value !== null) {
    for (const [key, child] of Object.entries(value)) {
      into.add(key);
      collectKeys(child, into);
    }
  }
  return into;
}

const CONTAINER = {
  id: 'snap1',
  tenantId: 't',
  containerId: 't1',
  containerSource: 'tank',
  name: 'Havuz 1',
  code: 'TNK-001',
  departmentId: null,
  siteId: 's1',
  status: 'active',
  volume: 120,
  maxBiomassKg: 12000,
  currentQuantity: 9500,
  currentBiomassKg: 3400,
  capacityUsedPercent: 28.3,
  isOverCapacity: false,
  hasActiveBatch: true,
  isActive: true,
  lastStockEventAt: new Date('2026-09-17T06:00:00.000Z'),
  createdAt: new Date(),
  updatedAt: new Date(),
} as unknown as FarmStockContainerSnapshot;

const BATCHES: FarmStockBatchSnapshot[] = [
  {
    id: 'bs1',
    tenantId: 't',
    containerId: 't1',
    batchId: 'b1',
    batchNumber: 'B-2026-001',
    batchStatus: 'active',
    speciesId: 'sp1',
    speciesName: 'Seabass',
    quantity: 9500,
    biomassKg: 3400,
    avgWeightG: 358,
    densityKgM3: 28.3,
    totalMortality: 480,
    totalCull: 20,
    harvestedQuantity: 0,
    isPrimary: true,
  } as unknown as FarmStockBatchSnapshot,
];

describe('farm-stock farm-AI projections (PR-5 read-only namespace)', () => {
  it('strips entity metadata — deep key scan', () => {
    const projection = projectStockContainer(CONTAINER, BATCHES);
    const keys = collectKeys(projection);
    for (const banned of BANNED_KEYS) {
      expect({ banned, present: keys.has(banned) }).toEqual({ banned, present: false });
    }
  });

  it('serializes dates as ISO and keeps stock numbers + batch attribution', () => {
    const projection = projectStockContainer(CONTAINER, BATCHES);
    expect(projection.lastStockEventAt).toBe('2026-09-17T06:00:00.000Z');
    expect(projection.currentBiomassKg).toBe(3400);
    expect(projection.capacityUsedPercent).toBe(28.3);
    expect(projection.batches[0]).toMatchObject({
      batchNumber: 'B-2026-001',
      speciesName: 'Seabass',
      isPrimary: true,
    });
  });
});
