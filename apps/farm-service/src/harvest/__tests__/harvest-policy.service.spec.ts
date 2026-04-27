/**
 * HarvestPolicyService Unit Tests
 *
 * Covers threshold decisions (biomass, quantity), env override
 * behaviour, active-plan status validation, batch-binding
 * enforcement, and the unplannedHarvest advisory flag.
 *
 * Uses hand-rolled doubles for Repository<HarvestPlan> and
 * ConfigService that expose only the methods the service consumes —
 * no `as any` anywhere.
 */
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { HarvestPlanRequiredError } from '../../common/errors/farm-errors';
import { ConfigService } from '@nestjs/config';
import { Repository } from 'typeorm';

import { HarvestPolicyService } from '../services/harvest-policy.service';
import {
  HarvestPlan,
  HarvestPlanStatus,
} from '../entities/harvest-plan.entity';

interface PlanRepoDouble {
  findOne: jest.Mock;
}

class StubConfigService {
  constructor(private readonly values: Record<string, string>) {}
  get<T = string>(key: string): T | undefined {
    const raw = this.values[key];
    return raw === undefined ? undefined : (raw as unknown as T);
  }
}

function makeService(
  env: Record<string, string> = {},
  planRepoOverride?: Partial<PlanRepoDouble>,
): {
  service: HarvestPolicyService;
  planRepo: PlanRepoDouble;
} {
  const planRepo: PlanRepoDouble = {
    findOne: jest.fn(),
    ...planRepoOverride,
  };
  const service = new HarvestPolicyService(
    planRepo as unknown as Repository<HarvestPlan>,
    new StubConfigService(env) as unknown as ConfigService,
  );
  return { service, planRepo };
}

const TENANT = '11111111-1111-4111-8111-111111111111';
const BATCH = '22222222-2222-4222-8222-222222222222';
const PLAN = '33333333-3333-4333-8333-333333333333';

describe('HarvestPolicyService', () => {
  describe('under the thresholds', () => {
    it('accepts unplanned harvest and sets unplannedHarvest=true', async () => {
      const { service } = makeService();
      const decision = await service.evaluate({
        tenantId: TENANT,
        batchId: BATCH,
        projectedBiomassKg: 500,
        projectedQuantity: 1_000,
      });
      expect(decision.planRequired).toBe(false);
      expect(decision.unplannedHarvest).toBe(true);
      expect(decision.biomassThresholdKg).toBe(10_000);
      expect(decision.quantityThreshold).toBe(50_000);
    });

    it('validates plan anyway when provided (still throws if bad)', async () => {
      const { service, planRepo } = makeService();
      planRepo.findOne.mockResolvedValue(null);
      await expect(
        service.evaluate({
          tenantId: TENANT,
          batchId: BATCH,
          projectedBiomassKg: 500,
          projectedQuantity: 1_000,
          harvestPlanId: PLAN,
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it('accepts a valid plan even below thresholds and flips unplannedHarvest false', async () => {
      const { service, planRepo } = makeService();
      planRepo.findOne.mockResolvedValue({
        id: PLAN,
        status: HarvestPlanStatus.APPROVED,
        batchId: BATCH,
      });
      const decision = await service.evaluate({
        tenantId: TENANT,
        batchId: BATCH,
        projectedBiomassKg: 500,
        projectedQuantity: 1_000,
        harvestPlanId: PLAN,
      });
      expect(decision.planRequired).toBe(false);
      expect(decision.unplannedHarvest).toBe(false);
    });
  });

  describe('above the biomass threshold', () => {
    it('rejects when no plan is provided', async () => {
      const { service } = makeService();
      await expect(
        service.evaluate({
          tenantId: TENANT,
          batchId: BATCH,
          projectedBiomassKg: 15_000,
          projectedQuantity: 1_000,
        }),
      ).rejects.toThrow(HarvestPlanRequiredError);
    });

    it('accepts when an APPROVED plan for the batch is cited', async () => {
      const { service, planRepo } = makeService();
      planRepo.findOne.mockResolvedValue({
        id: PLAN,
        status: HarvestPlanStatus.APPROVED,
        batchId: BATCH,
      });
      const decision = await service.evaluate({
        tenantId: TENANT,
        batchId: BATCH,
        projectedBiomassKg: 15_000,
        projectedQuantity: 1_000,
        harvestPlanId: PLAN,
      });
      expect(decision.planRequired).toBe(true);
      expect(decision.unplannedHarvest).toBe(false);
    });

    it('rejects when the plan is in DRAFT', async () => {
      const { service, planRepo } = makeService();
      planRepo.findOne.mockResolvedValue({
        id: PLAN,
        status: HarvestPlanStatus.DRAFT,
        batchId: BATCH,
      });
      await expect(
        service.evaluate({
          tenantId: TENANT,
          batchId: BATCH,
          projectedBiomassKg: 15_000,
          projectedQuantity: 1_000,
          harvestPlanId: PLAN,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects when the plan belongs to a different batch', async () => {
      const { service, planRepo } = makeService();
      planRepo.findOne.mockResolvedValue({
        id: PLAN,
        status: HarvestPlanStatus.APPROVED,
        batchId: 'some-other-batch',
      });
      await expect(
        service.evaluate({
          tenantId: TENANT,
          batchId: BATCH,
          projectedBiomassKg: 15_000,
          projectedQuantity: 1_000,
          harvestPlanId: PLAN,
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('above the quantity threshold', () => {
    it('rejects when no plan is provided', async () => {
      const { service } = makeService();
      await expect(
        service.evaluate({
          tenantId: TENANT,
          batchId: BATCH,
          projectedBiomassKg: 100,
          projectedQuantity: 60_000,
        }),
      ).rejects.toThrow(HarvestPlanRequiredError);
    });
  });

  describe('env-driven thresholds', () => {
    it('tightens the biomass threshold via env', async () => {
      const { service } = makeService({
        HARVEST_POLICY_MAX_UNPLANNED_BIOMASS_KG: '5000',
      });
      // 6000 kg now triggers planRequired.
      await expect(
        service.evaluate({
          tenantId: TENANT,
          batchId: BATCH,
          projectedBiomassKg: 6_000,
          projectedQuantity: 1_000,
        }),
      ).rejects.toThrow(HarvestPlanRequiredError);
    });

    it('falls back to default when env value is invalid', async () => {
      const { service } = makeService({
        HARVEST_POLICY_MAX_UNPLANNED_BIOMASS_KG: 'not-a-number',
      });
      // Default 10_000 threshold — 6000 kg is fine without a plan.
      const decision = await service.evaluate({
        tenantId: TENANT,
        batchId: BATCH,
        projectedBiomassKg: 6_000,
        projectedQuantity: 1_000,
      });
      expect(decision.planRequired).toBe(false);
    });
  });
});
