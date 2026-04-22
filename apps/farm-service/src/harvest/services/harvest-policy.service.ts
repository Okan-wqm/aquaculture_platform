/**
 * HarvestPolicyService
 *
 * Owns the "is a harvest plan mandatory for this harvest?" decision.
 * Large harvests MUST go through the plan workflow (approval, quality
 * criteria, financial projection, customer-order binding) because the
 * blast radius of a mistake — reject lot, grading failure, untracked
 * customer delivery — is disproportionately high. Small harvests
 * (single tank finishing out, for example) may flow without a plan to
 * keep day-to-day ops fast.
 *
 * Phase 2.2 of the "kalan kör noktalar" plan. Closes Girdi 15-B10
 * (harvest plan opsiyonel, shortcut-path compliance riski).
 *
 * Rules:
 *
 *   - When `projectedBiomassKg > 10_000` OR `projectedQuantity > 50_000`,
 *     the harvest handler MUST be called with a valid
 *     `harvestPlanId` that points to an APPROVED / SCHEDULED /
 *     IN_PROGRESS plan for the same batch. Draft, cancelled, postponed,
 *     or completed plans are rejected.
 *
 *   - Both thresholds are env-overridable
 *     (`HARVEST_POLICY_MAX_UNPLANNED_BIOMASS_KG`,
 *     `HARVEST_POLICY_MAX_UNPLANNED_QUANTITY`) so a stricter regulatory
 *     environment can tighten them without a code change.
 *
 *   - An advisory flag `unplannedHarvest: true` is returned for small
 *     harvests missing a plan. The caller stamps it on the audit log
 *     so ops leadership can review how often the shortcut is used.
 */
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import {
  HarvestPlan,
  HarvestPlanStatus,
} from '../entities/harvest-plan.entity';

export interface HarvestPolicyDecision {
  /** True when the harvest size crossed either configured threshold. */
  planRequired: boolean;
  /** True when the caller shipped without a plan but the policy allowed it. */
  unplannedHarvest: boolean;
  /** Configured biomass threshold at decision time — surfaced for audit logs. */
  biomassThresholdKg: number;
  /** Configured quantity threshold at decision time — surfaced for audit logs. */
  quantityThreshold: number;
}

export interface HarvestPolicyParams {
  tenantId: string;
  batchId: string;
  projectedBiomassKg: number;
  projectedQuantity: number;
  harvestPlanId?: string | null;
}

/** Industry-calibrated defaults — salmonid farms rarely harvest single tanks above these values. */
const DEFAULT_MAX_UNPLANNED_BIOMASS_KG = 10_000;
const DEFAULT_MAX_UNPLANNED_QUANTITY = 50_000;

/** Only these statuses allow a plan to back a physical harvest. */
const ACTIVE_PLAN_STATUSES: ReadonlySet<HarvestPlanStatus> = new Set([
  HarvestPlanStatus.APPROVED,
  HarvestPlanStatus.SCHEDULED,
  HarvestPlanStatus.IN_PROGRESS,
]);

@Injectable()
export class HarvestPolicyService {
  private readonly logger = new Logger(HarvestPolicyService.name);

  constructor(
    @InjectRepository(HarvestPlan)
    private readonly planRepo: Repository<HarvestPlan>,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Resolve the thresholds and decide whether a plan is mandatory.
   *
   * When the plan is mandatory, `harvestPlanId` MUST be provided and
   * MUST point at an APPROVED / SCHEDULED / IN_PROGRESS plan for the
   * same batch. Violations throw BadRequestException so the physical
   * harvest cannot proceed.
   *
   * When the plan is NOT mandatory but `harvestPlanId` is still
   * provided, we validate it anyway — ops should not be able to cite
   * an invalid plan on the harvest record.
   */
  async evaluate(params: HarvestPolicyParams): Promise<HarvestPolicyDecision> {
    const biomassThresholdKg = this.getBiomassThreshold();
    const quantityThreshold = this.getQuantityThreshold();

    const planRequired =
      params.projectedBiomassKg > biomassThresholdKg ||
      params.projectedQuantity > quantityThreshold;

    if (planRequired && !params.harvestPlanId) {
      throw new BadRequestException(
        `Harvest of batch ${params.batchId} exceeds the unplanned-harvest ` +
          `limits (biomass=${params.projectedBiomassKg}kg vs ${biomassThresholdKg}kg, ` +
          `quantity=${params.projectedQuantity} vs ${quantityThreshold}). ` +
          `A harvestPlanId pointing at an APPROVED / SCHEDULED / IN_PROGRESS ` +
          `plan for this batch is required. Create a harvest plan first.`,
      );
    }

    if (params.harvestPlanId) {
      await this.assertPlanUsable(
        params.tenantId,
        params.batchId,
        params.harvestPlanId,
      );
    }

    const unplannedHarvest = !params.harvestPlanId && !planRequired;
    if (unplannedHarvest) {
      this.logger.log(
        `Unplanned harvest recorded for batch ${params.batchId} within ` +
          `policy thresholds (biomass=${params.projectedBiomassKg}kg, ` +
          `quantity=${params.projectedQuantity}).`,
      );
    }

    return {
      planRequired,
      unplannedHarvest,
      biomassThresholdKg,
      quantityThreshold,
    };
  }

  private async assertPlanUsable(
    tenantId: string,
    batchId: string,
    planId: string,
  ): Promise<void> {
    const plan = await this.planRepo.findOne({
      where: { id: planId, tenantId },
      select: ['id', 'status', 'batchId'],
    });
    if (!plan) {
      throw new NotFoundException(
        `Harvest plan ${planId} not found for this tenant.`,
      );
    }
    if (plan.batchId !== batchId) {
      throw new BadRequestException(
        `Harvest plan ${planId} is bound to batch ${plan.batchId}, ` +
          `not ${batchId}. A harvest record cannot cite a plan that was ` +
          `drafted for a different batch.`,
      );
    }
    if (!ACTIVE_PLAN_STATUSES.has(plan.status)) {
      throw new BadRequestException(
        `Harvest plan ${planId} is in status ${plan.status}. Only APPROVED, ` +
          `SCHEDULED, or IN_PROGRESS plans can back a physical harvest.`,
      );
    }
  }

  private getBiomassThreshold(): number {
    return this.resolveNumericEnv(
      'HARVEST_POLICY_MAX_UNPLANNED_BIOMASS_KG',
      DEFAULT_MAX_UNPLANNED_BIOMASS_KG,
    );
  }

  private getQuantityThreshold(): number {
    return this.resolveNumericEnv(
      'HARVEST_POLICY_MAX_UNPLANNED_QUANTITY',
      DEFAULT_MAX_UNPLANNED_QUANTITY,
    );
  }

  private resolveNumericEnv(key: string, fallback: number): number {
    const raw = this.configService.get<number | string>(key);
    if (raw === undefined || raw === null || raw === '') {
      return fallback;
    }
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < 0) {
      this.logger.warn(
        `Ignoring invalid env ${key}=${raw}; using default ${fallback}.`,
      );
      return fallback;
    }
    return parsed;
  }
}
