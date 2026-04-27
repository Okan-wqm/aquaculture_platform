/**
 * BatchCostCalculatorService Unit Tests
 *
 * Covers each cost axis in isolation plus the aggregation, the
 * missing-data warning messages, the env-driven baseline labour
 * proxy, and the fallback from actual to theoretical biomass.
 *
 * Repository / ConfigService doubles are typed via narrow interfaces
 * so no `any` leaks into the spec.
 */
import { ConfigService } from '@nestjs/config';
import { Repository } from 'typeorm';

import { BatchCostCalculatorService } from '../../services/batch-cost-calculator.service';
import { Batch } from '../../entities/batch.entity';
import { HealthEvent } from '../../../fish-health/entities/health-event.entity';
import { WorkOrder } from '../../../maintenance/entities/work-order.entity';

interface HealthRepoDouble {
  find: jest.Mock;
}

interface QueryBuilderDouble {
  where: jest.Mock;
  andWhere: jest.Mock;
  select: jest.Mock;
  getMany: jest.Mock;
}

interface WorkOrderRepoDouble {
  createQueryBuilder: jest.Mock;
}

class StubConfigService {
  constructor(private readonly values: Record<string, string>) {}
  get<T = string>(key: string): T | undefined {
    const raw = this.values[key];
    return raw === undefined ? undefined : (raw as unknown as T);
  }
}

function makeQueryBuilder(rows: Partial<WorkOrder>[]): QueryBuilderDouble {
  const qb: QueryBuilderDouble = {
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    getMany: jest.fn().mockResolvedValue(rows),
  };
  return qb;
}

function makeService(opts: {
  healthEvents?: Array<Partial<HealthEvent>>;
  workOrders?: Array<Partial<WorkOrder>>;
  env?: Record<string, string>;
}): BatchCostCalculatorService {
  const healthRepo: HealthRepoDouble = {
    find: jest.fn().mockResolvedValue(opts.healthEvents ?? []),
  };
  const qb = makeQueryBuilder(opts.workOrders ?? []);
  const workOrderRepo: WorkOrderRepoDouble = {
    createQueryBuilder: jest.fn().mockReturnValue(qb),
  };
  return new BatchCostCalculatorService(
    healthRepo as unknown as Repository<HealthEvent>,
    workOrderRepo as unknown as Repository<WorkOrder>,
    new StubConfigService(opts.env ?? {}) as unknown as ConfigService,
  );
}

function makeBatch(overrides: Partial<Batch> = {}): Batch {
  const base = {
    id: 'batch-1',
    tenantId: 'tenant-1',
    purchaseCost: 10_000,
    totalFeedCost: 25_000,
    currentQuantity: 50_000,
    currency: 'TRY',
    stockedAt: new Date(Date.now() - 30 * 86_400_000), // 30 days ago
    weight: {
      actual: { totalBiomass: 10_000, avgWeight: 200 },
      theoretical: { totalBiomass: 9_500, avgWeight: 190 },
    },
  };
  return { ...base, ...overrides } as unknown as Batch;
}

describe('BatchCostCalculatorService', () => {
  describe('basic breakdown', () => {
    it('sums every axis and yields costPerKg / costPerFish', async () => {
      const service = makeService({
        healthEvents: [{ estimatedCost: 2_000 }, { estimatedCost: 500 }],
        workOrders: [
          {
            costSummary: {
              laborCost: 1_000,
              materialCost: 0,
              externalServiceCost: 0,
              otherCosts: 0,
              totalCost: 1_000,
              currency: 'USD',
            },
          },
        ],
      });

      const result = await service.compute(makeBatch());

      expect(result.purchaseCost).toBe(10_000);
      expect(result.feedCost).toBe(25_000);
      expect(result.treatmentCost).toBe(2_500);
      expect(result.labourCost).toBe(1_000);
      expect(result.equipmentAmortization).toBe(0);
      expect(result.totalCost).toBe(38_500);
      expect(result.currentBiomassKg).toBe(10_000);
      expect(result.costPerKg).toBeCloseTo(3.85, 2);
      expect(result.costPerFish).toBeCloseTo(0.77, 2);
    });

    it('falls back from actual to theoretical biomass when actual is missing', async () => {
      const service = makeService({});
      const batch = makeBatch({
        weight: {
          theoretical: { totalBiomass: 9_500, avgWeight: 190 },
        },
      } as unknown as Partial<Batch>);

      const result = await service.compute(batch);

      expect(result.currentBiomassKg).toBe(9_500);
    });

    it('returns costPerKg=0 and a warning when biomass is zero', async () => {
      const service = makeService({});
      const batch = makeBatch({
        weight: { actual: { totalBiomass: 0 }, theoretical: { totalBiomass: 0 } },
      } as unknown as Partial<Batch>);

      const result = await service.compute(batch);

      expect(result.costPerKg).toBe(0);
      expect(result.warnings).toContain(
        'Current biomass is zero — costPerKg cannot be computed',
      );
    });
  });

  describe('warnings', () => {
    it('warns when purchase cost is missing', async () => {
      const service = makeService({});
      const batch = makeBatch({ purchaseCost: undefined });
      const result = await service.compute(batch);
      expect(result.purchaseCost).toBe(0);
      expect(result.warnings).toContain('Missing purchase cost on batch');
    });

    it('warns when feed cost is missing', async () => {
      const service = makeService({});
      const batch = makeBatch({ totalFeedCost: undefined });
      const result = await service.compute(batch);
      expect(result.feedCost).toBe(0);
      expect(result.warnings).toContain('Missing aggregated feed cost');
    });

    it('warns when treatment cost is partially populated', async () => {
      const service = makeService({
        healthEvents: [
          { estimatedCost: 100 },
          { estimatedCost: undefined },
          { estimatedCost: 200 },
        ],
      });
      const result = await service.compute(makeBatch());
      expect(result.treatmentCost).toBe(300);
      expect(
        result.warnings.some((w) => w.includes('health event(s) have no estimatedCost')),
      ).toBe(true);
    });

    it('always warns about the pending equipment amortization axis', async () => {
      const service = makeService({});
      const result = await service.compute(makeBatch());
      expect(
        result.warnings.some((w) => w.includes('Equipment amortization pending')),
      ).toBe(true);
    });
  });

  describe('baseline labour via env', () => {
    it('adds per-day labour when BATCH_LABOUR_COST_PER_DAY is configured', async () => {
      const service = makeService({
        env: { BATCH_LABOUR_COST_PER_DAY: '50' },
      });
      const batch = makeBatch({
        stockedAt: new Date(Date.now() - 10 * 86_400_000),
      });
      const result = await service.compute(batch);
      // 10 days × 50 = 500 labour cost
      expect(result.labourCost).toBe(500);
    });

    it('ignores an invalid env value and warns', async () => {
      const service = makeService({
        env: { BATCH_LABOUR_COST_PER_DAY: 'nope' },
      });
      const result = await service.compute(makeBatch());
      expect(result.labourCost).toBe(0);
      expect(
        result.warnings.some((w) =>
          w.includes('Invalid BATCH_LABOUR_COST_PER_DAY'),
        ),
      ).toBe(true);
    });

    it('no warning when env is simply unset', async () => {
      const service = makeService({});
      const result = await service.compute(makeBatch());
      expect(result.labourCost).toBe(0);
      expect(
        result.warnings.some((w) => w.includes('BATCH_LABOUR_COST_PER_DAY')),
      ).toBe(false);
    });
  });
});
