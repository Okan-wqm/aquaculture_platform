/**
 * Projection spec for the feeding farm-AI responder (PR-4): PII deep ban,
 * ISO dates, cap/truncated.
 */
import {
  projectDailyFeedingPlan,
  projectFeedingSummary,
  projectSiteFeedConsumption,
  projectFeedProtocol,
} from '../projections';
import { FeedingProtocol } from '../../../feed/entities/feeding-protocol.entity';

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
  'measuredBy',
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

const PROTOCOL = {
  id: 'fp1',
  tenantId: 't',
  name: 'Seabass grow-out',
  description: 'protocol description',
  feedId: 'f1',
  species: 'Seabass',
  stage: 'grower',
  temperatureRanges: [{ min: 20 }],
  growthStageProtocols: [{ stage: 'grower' }],
  defaultSchedule: { mealsPerDay: 4 },
  targetFcr: 1.2,
  minDissolvedOxygen: 6,
  optimalTemperature: { min: 20, max: 26 },
  specialConditions: { winterFeeding: 'reduce' },
  isActive: true,
  isDefault: true,
  notes: 'operator note',
  createdAt: new Date(),
  updatedAt: new Date(),
} as unknown as FeedingProtocol;

describe('feeding farm-AI projections (PR-4 read-only namespace)', () => {
  it('strips PII, entity metadata and structured feeding tables — deep key scan', () => {
    const plan = projectDailyFeedingPlan({
      date: new Date('2026-09-18T00:00:00.000Z'),
      siteId: 's1',
      plannedFeedings: [
        {
          batchId: '',
          batchCode: '',
          tankId: 't1',
          tankCode: 'TNK-001',
          feedId: 'f1',
          feedName: 'Grower 3mm',
          plannedAmountKg: 12,
          actualAmountKg: 11,
          mealsPlanned: 4,
          mealsCompleted: 3,
          isComplete: false,
        },
      ],
      totalPlannedKg: 12,
      totalActualKg: 11,
      completionPercent: 92,
    });
    const summary = projectFeedingSummary({
      entityId: 'e1',
      entityType: 'batch',
      entityName: 'B-1',
      startDate: new Date('2026-08-01T00:00:00.000Z'),
      endDate: new Date('2026-09-01T00:00:00.000Z'),
      totalFeedingsCount: 10,
      totalPlannedKg: 100,
      totalActualKg: 95,
      totalVarianceKg: -5,
      totalWasteKg: 1,
      totalFeedCost: 380,
      avgDailyFeedingKg: 30,
      avgVariancePercent: -5,
      avgFeedingDuration: 22,
      appetiteDistribution: { excellent: 1, good: 2, moderate: 3, poor: 4, none: 5 },
      feedTypeDistribution: [{ feedId: 'f1', feedName: 'Grower', totalKg: 95, percentage: 100, cost: 380 }],
      dailyTrend: [{ date: '2026-08-01', plannedKg: 1, actualKg: 1, variancePercent: 0 }],
    });
    const consumption = projectSiteFeedConsumption({
      totalKg: 95,
      byFeedType: [{ feedName: 'Grower', brandName: 'Skretting', quantityKg: 95 }],
      recordCount: 10,
    });
    const protocol = projectFeedProtocol(PROTOCOL);

    for (const projection of [plan, summary, consumption, protocol]) {
      const keys = collectKeys(projection);
      for (const banned of BANNED_KEYS) {
        expect({ banned, present: keys.has(banned) }).toEqual({ banned, present: false });
      }
      expect(keys.has('temperatureRanges')).toBe(false);
      expect(keys.has('growthStageProtocols')).toBe(false);
      expect(keys.has('defaultSchedule')).toBe(false);
    }
  });

  it('serializes every date as an ISO string (or null)', () => {
    const summary = projectFeedingSummary({
      entityId: 'e1',
      entityType: 'tank',
      entityName: 'TNK-1',
      startDate: new Date('2026-08-01T00:00:00.000Z'),
      endDate: new Date('2026-09-01T00:00:00.000Z'),
      totalFeedingsCount: 0,
      totalPlannedKg: 0,
      totalActualKg: 0,
      totalVarianceKg: 0,
      totalWasteKg: 0,
      totalFeedCost: 0,
      avgDailyFeedingKg: 0,
      avgVariancePercent: 0,
      avgFeedingDuration: 0,
      appetiteDistribution: { excellent: 0, good: 0, moderate: 0, poor: 0, none: 0 },
      feedTypeDistribution: [],
      dailyTrend: [],
    });
    expect(summary.startDate).toBe('2026-08-01T00:00:00.000Z');
    expect(summary.endDate).toBe('2026-09-01T00:00:00.000Z');
  });

  it('caps embedded lists at 50 and flags truncation', () => {
    const trend = Array.from({ length: 80 }, (_, i) => ({
      date: `2026-08-${i + 1}`,
      plannedKg: 1,
      actualKg: 1,
      variancePercent: 0,
    }));
    const summary = projectFeedingSummary({
      entityId: 'e1',
      entityType: 'batch',
      entityName: 'B-1',
      startDate: new Date(),
      endDate: new Date(),
      totalFeedingsCount: 80,
      totalPlannedKg: 80,
      totalActualKg: 80,
      totalVarianceKg: 0,
      totalWasteKg: 0,
      totalFeedCost: 0,
      avgDailyFeedingKg: 1,
      avgVariancePercent: 0,
      avgFeedingDuration: 0,
      appetiteDistribution: { excellent: 0, good: 0, moderate: 0, poor: 0, none: 0 },
      feedTypeDistribution: [],
      dailyTrend: trend,
    });
    expect(summary.dailyTrend).toHaveLength(50);
    expect(summary.dailyTrendTruncated).toBe(true);

    const plan = projectDailyFeedingPlan({
      date: new Date(),
      siteId: 's1',
      plannedFeedings: Array.from({ length: 60 }, () => ({
        batchId: 'b',
        batchCode: 'B',
        tankId: 't',
        tankCode: 'T',
        feedId: 'f',
        feedName: 'F',
        plannedAmountKg: 1,
        actualAmountKg: 1,
        mealsPlanned: 1,
        mealsCompleted: 1,
        isComplete: true,
      })),
      totalPlannedKg: 60,
      totalActualKg: 60,
      completionPercent: 100,
    });
    expect(plan.plannedFeedings).toHaveLength(50);
    expect(plan.plannedFeedingsTruncated).toBe(true);

    const consumption = projectSiteFeedConsumption({
      totalKg: 60,
      byFeedType: Array.from({ length: 60 }, (_, i) => ({
        feedName: `F${i}`,
        quantityKg: 1,
      })),
      recordCount: 60,
    });
    expect(consumption.byFeedType).toHaveLength(50);
    expect(consumption.byFeedTypeTruncated).toBe(true);
  });
});
