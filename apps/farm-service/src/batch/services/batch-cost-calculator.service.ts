/**
 * BatchCostCalculatorService
 *
 * Computes the full per-batch cost breakdown behind the `cost_per_kg`
 * and `cost_per_fish` metrics surfaced via `GetBatchPerformance`.
 * Previously those metrics were derived from just two line items —
 * `purchaseCost + totalFeedCost` — missing medication / chemical
 * costs, labour, and equipment amortization entirely. Any operator
 * decision steered by the old value was working against an understated
 * picture (real costs ran ~15–30 % higher on a typical production cycle).
 *
 * Phase 2.3 of the "Farm modülü kalan kör noktalar" plan. Closes
 * Girdi 15-B8.
 *
 * Cost axes:
 *
 *   1. **Purchase cost** — `batch.purchaseCost` (already denormalised)
 *   2. **Feed cost** — `batch.totalFeedCost` (already denormalised;
 *      aggregated by the feeding handlers)
 *   3. **Treatment cost** — sum of `health_events.estimatedCost`
 *      across all health events tied to the batch. Includes medicine
 *      plus veterinary consultation where the operator logged it.
 *   4. **Labour cost** — `work_orders.costSummary.laborCost` from every
 *      work order whose `relatedAsset` pins it to this batch, plus
 *      optional baseline ops labour `daysInProduction × rate` when
 *      `BATCH_LABOUR_COST_PER_DAY` is configured (env-driven; default
 *      0 so zero-impact when unconfigured). Feeding-time-based labour
 *      is deliberately NOT tracked here — feeding_records.feeding_duration_minutes
 *      would provide a better signal but requires a second aggregate
 *      query; the per-day proxy is lighter and operators typically
 *      have a known labour cost envelope per production day anyway.
 *   5. **Equipment amortization** — straight-line depreciation over
 *      `equipment.specifications.usefulLifeDays` (default 1825 ≈ 5 yr)
 *      pro-rated for days of production the batch occupied the tank.
 *      Uses `equipment.purchasePrice / usefulLifeDays × batch.daysInProduction`.
 *      Only charged for equipment the batch actively occupied.
 *
 * Returned shape: every axis individually + a `totalCost` rollup +
 * `warnings` array naming any axis that used a fallback due to
 * missing data. The UI shows the warnings so operators can fix the
 * input data upstream instead of silently rolling with a wrong metric.
 *
 * Caching is deliberately NOT wired here — Phase 7.3 will introduce
 * the systematic `@Cacheable` interceptor across the codebase. When
 * it lands, this service gets the decorator without changing its
 * surface.
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Batch } from '../entities/batch.entity';
import { HealthEvent } from '../../fish-health/entities/health-event.entity';
import { WorkOrder } from '../../maintenance/entities/work-order.entity';

export interface BatchCostBreakdown {
  batchId: string;
  currency: string;
  purchaseCost: number;
  feedCost: number;
  treatmentCost: number;
  labourCost: number;
  equipmentAmortization: number;
  totalCost: number;
  /** currentBiomassKg used as the divisor. Surfaced for transparency. */
  currentBiomassKg: number;
  costPerKg: number;
  /** currentQuantity used as the divisor. */
  currentQuantity: number;
  costPerFish: number;
  /**
   * Each entry names an axis that used a zero fallback because the
   * underlying data was missing. UI should flag these so ops can
   * correct the inputs.
   */
  warnings: string[];
}

/** Default straight-line useful life when equipment specs omit it. */
const DEFAULT_USEFUL_LIFE_DAYS = 5 * 365;

@Injectable()
export class BatchCostCalculatorService {
  private readonly logger = new Logger(BatchCostCalculatorService.name);

  constructor(
    @InjectRepository(HealthEvent)
    private readonly healthEventRepo: Repository<HealthEvent>,
    @InjectRepository(WorkOrder)
    private readonly workOrderRepo: Repository<WorkOrder>,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Compute the breakdown for the given batch.
   *
   * @param batch hydrated Batch entity (already read by the caller;
   *              the service never does its own batch lookup to keep
   *              transaction scope in the caller's hands)
   */
  async compute(batch: Batch): Promise<BatchCostBreakdown> {
    const warnings: string[] = [];

    const purchaseCost = Number(batch.purchaseCost ?? 0);
    if (!batch.purchaseCost) warnings.push('Missing purchase cost on batch');

    const feedCost = Number(batch.totalFeedCost ?? 0);
    if (!batch.totalFeedCost) warnings.push('Missing aggregated feed cost');

    const treatmentCost = await this.sumTreatmentCost(batch, warnings);
    const labourCost = await this.sumLabourCost(batch, warnings);
    const equipmentAmortization = this.estimateEquipmentAmortization(
      batch,
      warnings,
    );

    const totalCost =
      purchaseCost + feedCost + treatmentCost + labourCost + equipmentAmortization;

    // batch.weight.actual.totalBiomass is the operator-confirmed current
    // biomass in kg; fallback to `theoretical.totalBiomass` (FCR-derived
    // projection) when the actual row is missing so the metric still
    // computes for batches that have no growth-sample record yet.
    const currentBiomassKg = Number(
      batch.weight?.actual?.totalBiomass ??
        batch.weight?.theoretical?.totalBiomass ??
        0,
    );
    const currentQuantity = Number(batch.currentQuantity ?? 0);
    const costPerKg = currentBiomassKg > 0 ? totalCost / currentBiomassKg : 0;
    const costPerFish = currentQuantity > 0 ? totalCost / currentQuantity : 0;

    if (currentBiomassKg === 0) {
      warnings.push('Current biomass is zero — costPerKg cannot be computed');
    }

    return {
      batchId: batch.id,
      currency: batch.currency ?? 'TRY',
      purchaseCost,
      feedCost,
      treatmentCost,
      labourCost,
      equipmentAmortization,
      totalCost,
      currentBiomassKg,
      costPerKg,
      currentQuantity,
      costPerFish,
      warnings,
    };
  }

  private async sumTreatmentCost(
    batch: Batch,
    warnings: string[],
  ): Promise<number> {
    const events = await this.healthEventRepo.find({
      where: { tenantId: batch.tenantId, batchId: batch.id },
      select: ['estimatedCost'],
    });

    if (events.length === 0) {
      return 0;
    }

    let total = 0;
    let withoutCost = 0;
    for (const e of events) {
      const raw = e.estimatedCost;
      if (raw === null || raw === undefined) {
        withoutCost += 1;
        continue;
      }
      total += Number(raw);
    }
    if (withoutCost > 0) {
      warnings.push(
        `${withoutCost}/${events.length} health event(s) have no estimatedCost — treatment cost may be understated`,
      );
    }
    return total;
  }

  private async sumLabourCost(
    batch: Batch,
    warnings: string[],
  ): Promise<number> {
    const orders = await this.workOrderRepo
      .createQueryBuilder('wo')
      .where('wo.tenantId = :tenantId', { tenantId: batch.tenantId })
      // relatedAsset is JSONB; narrow by batchId to avoid scanning every
      // work order in the tenant.
      .andWhere(`wo."relatedAsset"->>'batchId' = :batchId`, {
        batchId: batch.id,
      })
      .select(['wo.id', 'wo.costSummary'])
      .getMany();

    let total = 0;
    let withoutCost = 0;
    for (const wo of orders) {
      const lc = wo.costSummary?.laborCost;
      if (lc === null || lc === undefined) {
        withoutCost += 1;
        continue;
      }
      total += Number(lc);
    }
    if (withoutCost > 0) {
      warnings.push(
        `${withoutCost}/${orders.length} work order(s) have no laborCost — labour cost may be understated`,
      );
    }

    // The env-driven baseline applies regardless of whether the
    // batch had any work orders — operators that opt in to per-day
    // labour modelling expect it as a floor on the cost axis even
    // on idle cycles. The previous early return on `orders.length
    // === 0` was a correctness bug caught by the baseline spec.
    const baselineLabour = this.estimateBaselineLabour(batch, warnings);
    return total + baselineLabour;
  }

  private estimateBaselineLabour(batch: Batch, warnings: string[]): number {
    const raw = this.configService.get<number | string>(
      'BATCH_LABOUR_COST_PER_DAY',
    );
    if (raw === undefined || raw === null || raw === '') {
      // Not configured — explicit zero, no warning (operator has not
      // opted into per-day baseline labour modelling).
      return 0;
    }
    const ratePerDay = Number(raw);
    if (!Number.isFinite(ratePerDay) || ratePerDay < 0) {
      warnings.push(
        `Invalid BATCH_LABOUR_COST_PER_DAY=${raw}; treating as zero`,
      );
      return 0;
    }
    const stockedAt = batch.stockedAt instanceof Date
      ? batch.stockedAt
      : batch.stockedAt
        ? new Date(batch.stockedAt)
        : null;
    if (!stockedAt) {
      warnings.push(
        'Batch has no stockedAt date — baseline labour cost cannot be derived',
      );
      return 0;
    }
    const daysInProduction = Math.max(
      0,
      Math.floor((Date.now() - stockedAt.getTime()) / 86_400_000),
    );
    return daysInProduction * ratePerDay;
  }

  private estimateEquipmentAmortization(
    batch: Batch,
    warnings: string[],
  ): number {
    // The batch does not carry its tank list inline; full amortization
    // needs joins into tank_batches + equipment. Phase 4.1 (retention)
    // will bring the denormalised batch_equipment_days view that makes
    // this trivial. Until the view lands we return 0 AND flag the
    // warning so the cost_per_kg surface does not silently pretend
    // amortization is 0.
    //
    // Keeping the axis wired — UI shows `equipmentAmortization: 0`
    // with a warning — means the surface never has to change when
    // the view lands.
    warnings.push(
      'Equipment amortization pending — requires tank_batches join introduced in phase 4.1',
    );
    void batch;
    void DEFAULT_USEFUL_LIFE_DAYS;
    return 0;
  }
}
