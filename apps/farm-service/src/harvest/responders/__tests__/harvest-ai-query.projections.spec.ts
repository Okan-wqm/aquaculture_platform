/**
 * Projection spec for the harvest farm-AI responder (PR-4): PII deep ban,
 * ISO dates.
 */
import { projectHarvestPlan } from '../projections';
import { HarvestPlan } from '../../entities/harvest-plan.entity';

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
  'customerOrder',
  'customerName',
  'logistics',
  'destinationAddress',
  'financialProjection',
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

const PLAN: HarvestPlan = {
  id: 'hp1',
  tenantId: 't',
  planCode: 'HP-2026-00001',
  name: 'Autumn harvest',
  description: 'desc',
  batchId: 'b1',
  status: 'approved',
  harvestType: 'partial',
  plannedDate: new Date('2026-10-01T00:00:00.000Z'),
  confirmedDate: null,
  windowStartDate: new Date('2026-09-25T00:00:00.000Z'),
  windowEndDate: new Date('2026-10-10T00:00:00.000Z'),
  criteria: {
    targetWeight: { min: 380, max: 460, target: 420 },
    targetQuantity: { value: 5000, unit: 'pieces' },
    qualityGrade: 'A',
  } as HarvestPlan['criteria'],
  harvestMethod: 'seine',
  productForm: 'fresh',
  estimates: {
    estimatedQuantity: 5000,
    estimatedBiomass: 2100,
    estimatedAvgWeight: 420,
    estimatedYield: 86,
    confidenceLevel: 'high',
  } as HarvestPlan['estimates'],
  financialProjection: {
    estimatedRevenue: 100000,
    estimatedPrice: 45,
    priceUnit: 'per_kg',
    estimatedCost: 60000,
    estimatedProfit: 40000,
    margin: 40,
    currency: 'NOK',
  } as HarvestPlan['financialProjection'],
  logistics: {
    harvestStartTime: '06:00',
    destinationAddress: 'Harbor 4',
    requiredPersonnel: 6,
  } as HarvestPlan['logistics'],
  customerOrder: {
    customerName: 'BigFish AS',
    orderQuantity: 5000,
  } as HarvestPlan['customerOrder'],
  actualQuantityHarvested: null,
  actualBiomassHarvested: null,
  actualAvgWeight: null,
  approvedBy: 'user-id',
  createdBy: 'user-id',
  notes: 'operator note',
  attachments: ['s3://bucket/plan.pdf'],
} as unknown as HarvestPlan;

describe('harvest farm-AI projections (PR-4 read-only namespace)', () => {
  it('strips approver/creator PII, commercial and logistics blobs — deep key scan', () => {
    const projection = projectHarvestPlan(PLAN);
    const keys = collectKeys(projection);
    for (const banned of BANNED_KEYS) {
      expect({ banned, present: keys.has(banned) }).toEqual({ banned, present: false });
    }
    const serialized = JSON.stringify(projection);
    expect(serialized).not.toContain('BigFish AS');
    expect(serialized).not.toContain('Harbor 4');
    expect(serialized).not.toContain('s3://');
  });

  it('serializes dates as ISO and flattens criteria/estimates', () => {
    const projection = projectHarvestPlan(PLAN);
    expect(projection.plannedDate).toBe('2026-10-01T00:00:00.000Z');
    expect(projection.confirmedDate).toBeNull();
    expect(projection.windowStartDate).toBe('2026-09-25T00:00:00.000Z');
    expect(projection.criteria.targetWeightG).toBe(420);
    expect(projection.estimates.estimatedBiomassKg).toBe(2100);
    expect(projection.estimates.confidenceLevel).toBe('high');
  });
});
