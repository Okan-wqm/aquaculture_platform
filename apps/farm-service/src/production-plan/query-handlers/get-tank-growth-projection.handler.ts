/**
 * GetTankGrowthProjectionQuery handler — the production-plan simulation.
 *
 * Per tank holding stock with an ACTIVE protocol assignment, walks the
 * horizon day by day under the chosen temperature scenario:
 *
 *   temp(d)      = scenario piecewise-linear interpolation (clamped at ends)
 *   band(d)      = protocol band by the tank's average weight
 *   feedKg(d)    = biomass × band.feedingRatePercent/100 × tempMultiplier
 *   growthKg(d)  = feedKg ÷ expectedFcr (override → matrix → feed → band)
 *   biomass(d+1) = biomass + growth; avgWeight = biomass×1000 / fishCount
 *
 * Capacity fill percent uses the tank's maxBiomass when set, else
 * maxDensity kg/m³ × volume m³. Without a scenario the simulation falls back
 * to the tank's current effective temperature held constant, so the
 * projection works before any scenario exists.
 */
import { runInTenantRead } from '@aquaculture/backend-common/database';
import { InjectDataSource } from '@nestjs/typeorm';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { DataSource, In } from 'typeorm';

import { GetTankGrowthProjectionQuery } from '../queries/get-tank-growth-projection.query';
import {
  TemperatureScenario,
  TemperatureScenarioSource,
} from '../entities/temperature-scenario.entity';
import { TemperatureScenarioPoint } from '../entities/temperature-scenario-point.entity';
import { ProtocolAssignment } from '../../feeding-protocol/entities/protocol-assignment.entity';
import { FeedingProtocolV2 } from '../../feeding-protocol/entities/feeding-protocol-v2.entity';
import type { FcrOverride } from '../../feeding-protocol/entities/protocol-assignment.entity';
import { ProtocolRateService } from '../../feeding-protocol/services/protocol-rate.service';
import { simulateProtocolDay } from '../../feeding-protocol/services/protocol-day-step.util';
import { TankBatch } from '../../batch/entities/tank-batch.entity';
import { Equipment } from '../../equipment/entities/equipment.entity';
import { WaterTemperatureService } from '../../water-quality/services/water-temperature.service';

interface DayPoint {
  day: number;
  date: string;
  temperatureC: number;
  avgWeightG: number;
  biomassKg: number;
  feedKg: number;
  capacityPercent: number;
}

interface TankProjection {
  unitId: string;
  unitCode: string;
  unitName: string;
  siteId: string;
  siteName: string;
  departmentId: string | null;
  departmentName: string | null;
  protocolId: string;
  protocolName: string;
  fishCount: number;
  currentAvgWeightG: number;
  currentBiomassKg: number;
  capacityKg: number | null;
  projectedAvgWeightG: number;
  projectedBiomassKg: number;
  totalFeedKg: number;
  peakCapacityPercent: number;
  overCapacityDay: number | null;
  series: DayPoint[];
}

/** Piecewise-linear interpolation over dated points, clamped at both ends. */
export function interpolateTemperature(
  points: { date: string; celsius: number }[],
  isoDate: string,
): number | null {
  if (points.length === 0) return null;
  const sorted = [...points].sort((a, b) => a.date.localeCompare(b.date));
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  if (!first || !last) return null;
  if (isoDate <= first.date) return first.celsius;
  if (isoDate >= last.date) return last.celsius;
  for (let i = 1; i < sorted.length; i += 1) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    if (!prev || !cur) break;
    if (isoDate >= prev.date && isoDate <= cur.date) {
      const t0 = Date.parse(`${prev.date}T00:00:00Z`);
      const t1 = Date.parse(`${cur.date}T00:00:00Z`);
      const tt = Date.parse(`${isoDate}T00:00:00Z`);
      if (t1 === t0) return cur.celsius;
      const ratio = (tt - t0) / (t1 - t0);
      return prev.celsius + (cur.celsius - prev.celsius) * ratio;
    }
  }
  return last.celsius;
}

@QueryHandler(GetTankGrowthProjectionQuery)
export class GetTankGrowthProjectionHandler implements IQueryHandler<GetTankGrowthProjectionQuery> {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly rateService: ProtocolRateService,
    private readonly waterTemperature: WaterTemperatureService,
  ) {}

  async execute(query: GetTankGrowthProjectionQuery): Promise<TankProjection[]> {
    const { tenantId, input } = query;
    const horizon = Math.min(Math.max(Math.trunc(input.horizonDays) || 30, 7), 365);

    return runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      // 1) Active protocol assignments in scope
      const assignmentWhere: Record<string, unknown> = { tenantId, status: 'active' };
      if (input.siteId) assignmentWhere.siteId = input.siteId;
      const assignments = await queryRunner.manager.find(ProtocolAssignment, {
        where: assignmentWhere,
      });
      if (assignments.length === 0) return [];
      const unitIds = assignments.map((a) => a.unitId);

      // 2) Department scoping (system = department) after the site filter
      let scopedUnitIds = unitIds;
      if (input.departmentId) {
        const units = await queryRunner.manager.find(Equipment, {
          where: { tenantId, id: In(unitIds) },
        });
        scopedUnitIds = units.filter((u) => u.departmentId === input.departmentId).map((u) => u.id);
        if (scopedUnitIds.length === 0) return [];
      }

      // 3) Scenario points (site of the first assignment in scope) or null
      let scenarioPoints: { date: string; celsius: number }[] | null = null;
      if (input.scenarioId) {
        const scenario = await queryRunner.manager.findOne(TemperatureScenario, {
          where: { id: input.scenarioId, tenantId, isDeleted: false },
        });
        if (!scenario) return [];
        const points = await queryRunner.manager.find(TemperatureScenarioPoint, {
          where: { tenantId, scenarioId: scenario.id },
        });
        scenarioPoints = points
          .map((p) => ({ date: p.date, celsius: p.celsius }))
          .sort((a, b) => a.date.localeCompare(b.date));
      }

      // 4) Tanks + stock + protocol data
      const [tanks, batches, protocols] = await Promise.all([
        queryRunner.manager.find(Equipment, { where: { tenantId, id: In(scopedUnitIds) } }),
        queryRunner.manager.find(TankBatch, { where: { tenantId, tankId: In(scopedUnitIds) } }),
        queryRunner.manager.find(FeedingProtocolV2, {
          where: {
            tenantId,
            id: In(assignments.map((a) => a.protocolId)),
            isDeleted: false,
          },
        }),
      ]);
      const tankById = new Map(tanks.map((t) => [t.id, t]));
      const batchByTank = new Map(batches.map((b) => [b.tankId, b]));
      const protocolById = new Map(protocols.map((p) => [p.id, p]));

      const results: TankProjection[] = [];

      for (const assignment of assignments) {
        if (!scopedUnitIds.includes(assignment.unitId)) continue;
        const tank = tankById.get(assignment.unitId);
        const batch = batchByTank.get(assignment.unitId);
        const protocol = protocolById.get(assignment.protocolId);
        if (!tank || !batch || !protocol) continue;
        if ((batch.totalQuantity ?? 0) <= 0) continue;

        const specs = (tank as Equipment & { specifications?: Record<string, unknown> })
          .specifications;
        const volume = Number(tank.volume ?? specs?.effectiveVolume ?? specs?.waterVolume ?? 0);
        const maxBiomass = Number(specs?.maxBiomass ?? 0) || null;
        const maxDensity = Number(specs?.maxDensity ?? 0) || null;
        const capacityKg = maxBiomass ?? (maxDensity && volume ? maxDensity * volume : null);

        let fishCount = batch.totalQuantity;
        let biomassKg = Number(batch.totalBiomassKg);
        let avgWeightG = Number(batch.avgWeightG);
        const currentAvgWeightG = avgWeightG;
        const currentBiomassKg = biomassKg;

        const overrides = assignment.overrides ?? {};
        const fcrOverrides: FcrOverride[] = overrides.fcrOverrides ?? [];
        const series: DayPoint[] = [];
        let totalFeedKg = 0;
        let peakCapacityPercent = 0;
        let overCapacityDay: number | null = null;

        for (let day = 1; day <= horizon; day += 1) {
          const isoDate = new Date(Date.now() + day * 86_400_000).toISOString().slice(0, 10);
          const temperatureC = scenarioPoints
            ? interpolateTemperature(scenarioPoints, isoDate)
            : (await this.waterTemperature.getEffectiveTemperature(tenantId, assignment.unitId))
                .celsius;

          const resolvedBand = this.rateService.bandFor(protocol.bands, avgWeightG);
          if (!resolvedBand) break;

          // Per-day physics lives in the shared simulation core (SSoT — the
          // feed forecast runs the same step; this also brings the min/max
          // rate clamps and the feed-product FCR matrix the inline version
          // had drifted away from).
          const step = simulateProtocolDay(this.rateService, {
            protocol,
            band: resolvedBand.band,
            avgWeightG,
            biomassKg,
            fishCount,
            temperatureC,
            rateAdjustmentPercent: overrides.rateAdjustmentPercent,
            fcrOverrides,
          });
          const growthKg = step.growthKg;

          biomassKg = step.nextBiomassKg;
          totalFeedKg += step.feedKg;
          avgWeightG = step.nextAvgWeightG;

          const capacityPercent = capacityKg ? (biomassKg / capacityKg) * 100 : 0;
          if (capacityPercent > peakCapacityPercent) peakCapacityPercent = capacityPercent;
          if (capacityPercent > 100 && overCapacityDay === null) overCapacityDay = day;

          series.push({
            day,
            date: isoDate,
            temperatureC: temperatureC ?? 0,
            avgWeightG: Math.round(avgWeightG * 100) / 100,
            biomassKg: Math.round(biomassKg * 1000) / 1000,
            feedKg: Math.round(step.feedKg * 1000) / 1000,
            capacityPercent: Math.round(capacityPercent * 10) / 10,
          });
        }

        const tankDept = (
          tank as Equipment & {
            department?: {
              id: string;
              name: string;
              site?: { id: string; name: string } | null;
            } | null;
          }
        ).department;
        results.push({
          unitId: tank.id,
          unitCode: tank.code,
          unitName: tank.name,
          siteId: assignment.siteId,
          siteName: tankDept?.site?.name ?? '',
          departmentId: tank.departmentId ?? null,
          departmentName: tankDept?.name ?? null,
          protocolId: protocol.id,
          protocolName: protocol.name,
          fishCount,
          currentAvgWeightG,
          currentBiomassKg,
          capacityKg,
          projectedAvgWeightG: Math.round(avgWeightG * 100) / 100,
          projectedBiomassKg: Math.round(biomassKg * 1000) / 1000,
          totalFeedKg: Math.round(totalFeedKg * 1000) / 1000,
          peakCapacityPercent: Math.round(peakCapacityPercent * 10) / 10,
          overCapacityDay,
          series,
        });
      }

      return results;
    });
  }
}
