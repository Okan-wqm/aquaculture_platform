/**
 * BatchCostCalculatorService Unit Tests
 *
 * Covers each cost axis in isolation plus the aggregation, the
 * missing-data warning messages, the env-driven baseline labour
 * proxy, and the fallback from actual to theoretical biomass.
 *
 * EntityManager / ConfigService doubles are built with the typed
 * `collaborator` factory so no `any` leaks into the spec. The manager backs
 * the caller's TenantScope (K10 layer 4): the service reads health_events
 * and work_orders only through that scope.
 */
import { ConfigService } from '@nestjs/config';
import { collaborator } from '@aquaculture/testing';
import type { EntityManager } from 'typeorm';

import { BatchCostCalculatorService } from '../../services/batch-cost-calculator.service';
import { Batch } from '../../entities/batch.entity';
import { HealthEvent } from '../../../fish-health/entities/health-event.entity';
import { WorkOrder } from '../../../maintenance/entities/work-order.entity';
import { inTenantScopeOver } from '../../../__tests__/helpers/farm-tenant-scope.helper';

/** The tenant the caller's scope is pinned to. */
const SCOPE_TENANT = '11111111-1111-4111-8111-111111111111';

interface QueryBuilderDouble {
  where: jest.Mock;
  andWhere: jest.Mock;
  select: jest.Mock;
  getMany: jest.Mock;
}

/** A ConfigService double answering `get(key)` from a plain env map. */
function stubConfig(values: Record<string, string>): ConfigService {
  return collaborator<ConfigService>({ get: jest.fn((key: string) => values[key]) }, 'ConfigService');
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

interface CostFixture {
  readonly service: BatchCostCalculatorService;
  /** The caller's tenant-bound manager the service must read through. */
  readonly manager: EntityManager;
  readonly find: jest.Mock;
  readonly createQueryBuilder: jest.Mock;
  readonly workOrderQuery: QueryBuilderDouble;
}

function makeService(opts: {
  healthEvents?: Array<Partial<HealthEvent>>;
  workOrders?: Array<Partial<WorkOrder>>;
  env?: Record<string, string>;
}): CostFixture {
  const find = jest.fn().mockResolvedValue(opts.healthEvents ?? []);
  const workOrderQuery = makeQueryBuilder(opts.workOrders ?? []);
  const createQueryBuilder = jest.fn().mockReturnValue(workOrderQuery);
  return {
    service: new BatchCostCalculatorService(stubConfig(opts.env ?? {})),
    manager: collaborator<EntityManager>({ find, createQueryBuilder }, 'EntityManager'),
    find,
    createQueryBuilder,
    workOrderQuery,
  };
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
      const { service, manager } = makeService({
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

      const result = await inTenantScopeOver(manager, SCOPE_TENANT, (scope) => service.compute(makeBatch(), scope));

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

    it("reads the treatment and labour axes only through the caller's manager (K10 layer 4)", async () => {
      // SCENARIO: the handler hands over its runInTenantRead transaction's manager.
      // EXPECTS: health_events and work_orders are read through THAT manager, each
      //          filtered to the batch's own tenant — the service holds no repository.
      const { service, manager, find, createQueryBuilder, workOrderQuery } = makeService({});

      await inTenantScopeOver(manager, SCOPE_TENANT, (scope) => service.compute(makeBatch(), scope));

      expect(find).toHaveBeenCalledWith(HealthEvent, {
        where: { tenantId: 'tenant-1', batchId: 'batch-1' },
        select: ['estimatedCost'],
      });
      expect(createQueryBuilder).toHaveBeenCalledWith(WorkOrder, 'wo');
      expect(workOrderQuery.where).toHaveBeenCalledWith('wo.tenantId = :tenantId', { tenantId: 'tenant-1' });
    });

    it('falls back from actual to theoretical biomass when actual is missing', async () => {
      const { service, manager } = makeService({});
      const batch = makeBatch({
        weight: {
          theoretical: { totalBiomass: 9_500, avgWeight: 190 },
        },
      } as unknown as Partial<Batch>);

      const result = await inTenantScopeOver(manager, SCOPE_TENANT, (scope) => service.compute(batch, scope));

      expect(result.currentBiomassKg).toBe(9_500);
    });

    it('returns costPerKg=0 and a warning when biomass is zero', async () => {
      const { service, manager } = makeService({});
      const batch = makeBatch({
        weight: { actual: { totalBiomass: 0 }, theoretical: { totalBiomass: 0 } },
      } as unknown as Partial<Batch>);

      const result = await inTenantScopeOver(manager, SCOPE_TENANT, (scope) => service.compute(batch, scope));

      expect(result.costPerKg).toBe(0);
      expect(result.warnings).toContain(
        'Current biomass is zero — costPerKg cannot be computed',
      );
    });
  });

  describe('warnings', () => {
    it('warns when purchase cost is missing', async () => {
      const { service, manager } = makeService({});
      const batch = makeBatch({ purchaseCost: undefined });
      const result = await inTenantScopeOver(manager, SCOPE_TENANT, (scope) => service.compute(batch, scope));
      expect(result.purchaseCost).toBe(0);
      expect(result.warnings).toContain('Missing purchase cost on batch');
    });

    it('warns when feed cost is missing', async () => {
      const { service, manager } = makeService({});
      const batch = makeBatch({ totalFeedCost: undefined });
      const result = await inTenantScopeOver(manager, SCOPE_TENANT, (scope) => service.compute(batch, scope));
      expect(result.feedCost).toBe(0);
      expect(result.warnings).toContain('Missing aggregated feed cost');
    });

    it('warns when treatment cost is partially populated', async () => {
      const { service, manager } = makeService({
        healthEvents: [
          { estimatedCost: 100 },
          { estimatedCost: undefined },
          { estimatedCost: 200 },
        ],
      });
      const result = await inTenantScopeOver(manager, SCOPE_TENANT, (scope) => service.compute(makeBatch(), scope));
      expect(result.treatmentCost).toBe(300);
      expect(
        result.warnings.some((w) => w.includes('health event(s) have no estimatedCost')),
      ).toBe(true);
    });

    it('always warns about the pending equipment amortization axis', async () => {
      const { service, manager } = makeService({});
      const result = await inTenantScopeOver(manager, SCOPE_TENANT, (scope) => service.compute(makeBatch(), scope));
      expect(
        result.warnings.some((w) => w.includes('Equipment amortization pending')),
      ).toBe(true);
    });
  });

  describe('baseline labour via env', () => {
    it('adds per-day labour when BATCH_LABOUR_COST_PER_DAY is configured', async () => {
      const { service, manager } = makeService({
        env: { BATCH_LABOUR_COST_PER_DAY: '50' },
      });
      const batch = makeBatch({
        stockedAt: new Date(Date.now() - 10 * 86_400_000),
      });
      const result = await inTenantScopeOver(manager, SCOPE_TENANT, (scope) => service.compute(batch, scope));
      // 10 days × 50 = 500 labour cost
      expect(result.labourCost).toBe(500);
    });

    it('ignores an invalid env value and warns', async () => {
      const { service, manager } = makeService({
        env: { BATCH_LABOUR_COST_PER_DAY: 'nope' },
      });
      const result = await inTenantScopeOver(manager, SCOPE_TENANT, (scope) => service.compute(makeBatch(), scope));
      expect(result.labourCost).toBe(0);
      expect(
        result.warnings.some((w) =>
          w.includes('Invalid BATCH_LABOUR_COST_PER_DAY'),
        ),
      ).toBe(true);
    });

    it('no warning when env is simply unset', async () => {
      const { service, manager } = makeService({});
      const result = await inTenantScopeOver(manager, SCOPE_TENANT, (scope) => service.compute(makeBatch(), scope));
      expect(result.labourCost).toBe(0);
      expect(
        result.warnings.some((w) => w.includes('BATCH_LABOUR_COST_PER_DAY')),
      ).toBe(false);
    });
  });
});
