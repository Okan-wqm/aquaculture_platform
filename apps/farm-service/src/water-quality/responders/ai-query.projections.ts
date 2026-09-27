import type {
  CriticalWaterQualityDto,
  WaterQualityStatsReply,
  WaterQualityThresholdDto,
  WqMeasurementDto,
} from '@platform/event-contracts';
import { toEventIso } from '@platform/event-contracts';
import { isoOrNull, numberOrNull } from '../../common/nats/ai-query-responder';
import type { WaterQualityMeasurement } from '../entities/water-quality-measurement.entity';
import type { WaterQualityParameterConfig } from '../entities/water-quality-parameter-config.entity';
import type { WaterQualityStatsResult } from '../query-handlers/water-quality-stats.result';

/**
 * Pure projections from farm entities to the AI read contract. Unit-suffixed
 * numerics, ISO dates, nulls for unmeasured values; no operator identities,
 * sensor metadata or free text.
 */

export function projectMeasurement(row: WaterQualityMeasurement): WqMeasurementDto {
  const p = row.parameters;
  return {
    measuredAt: toEventIso(row.measuredAt),
    tankId: row.tankId ?? null,
    pondId: row.pondId ?? null,
    temperatureC: numberOrNull(row.temperature ?? numberFrom(p.temperature)),
    doMgL: numberOrNull(row.dissolvedOxygen ?? numberFrom(p.dissolvedOxygen)),
    doSaturationPct: numberOrNull(numberFrom(p.oxygenSaturation)),
    ph: numberOrNull(row.pH ?? numberFrom(p.pH)),
    salinityPpt: numberOrNull(numberFrom(p.salinity)),
    ammoniaMgL: numberOrNull(row.ammonia ?? numberFrom(p.ammonia)),
    tanMgL: numberOrNull(numberFrom(p.totalAmmoniaNitrogen)),
    nitriteMgL: numberOrNull(row.nitrite ?? numberFrom(p.nitrite)),
    nitrateMgL: numberOrNull(numberFrom(p.nitrate)),
    alkalinityMgL: numberOrNull(numberFrom(p.alkalinity)),
    overallStatus: row.overallStatus,
  };
}

function numberFrom(value: number | string | boolean | undefined): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

export function projectStats(
  scopeId: string,
  days: number,
  stats: WaterQualityStatsResult,
): WaterQualityStatsReply {
  return {
    scopeId,
    days,
    measurementCount: stats.measurementCount,
    criticalCount: stats.criticalCount,
    warningCount: stats.warningCount,
    avgTemperatureC: numberOrNull(stats.avgTemperature),
    avgDoMgL: numberOrNull(stats.avgDO),
    avgPh: numberOrNull(stats.avgPH),
    avgAmmoniaMgL: numberOrNull(stats.avgAmmonia),
    avgNitriteMgL: numberOrNull(stats.avgNitrite),
    lastMeasurement: stats.lastMeasurement ? projectMeasurement(stats.lastMeasurement) : null,
  };
}

export function projectCritical(row: WaterQualityMeasurement): CriticalWaterQualityDto {
  const evaluations = row.summary?.evaluations ?? [];
  return {
    measuredAt: toEventIso(row.measuredAt),
    tankId: row.tankId ?? null,
    pondId: row.pondId ?? null,
    overallStatus: row.overallStatus,
    criticalParameters: evaluations
      .filter((e) => e.status !== 'optimal' && e.status !== 'not_measured')
      .map((e) => ({
        parameter: e.parameter,
        value: e.value,
        unit: e.unit,
        status: e.status,
        criticalMin: numberOrNull(e.criticalMin),
        criticalMax: numberOrNull(e.criticalMax),
      })),
  };
}

export function projectThreshold(row: WaterQualityParameterConfig): WaterQualityThresholdDto {
  return {
    code: row.code,
    name: row.name,
    unit: row.unit,
    group: row.group,
    optimalMin: numberOrNull(row.optimalMin),
    optimalMax: numberOrNull(row.optimalMax),
    warningMin: numberOrNull(row.warningMin),
    warningMax: numberOrNull(row.warningMax),
    criticalMin: numberOrNull(row.criticalMin),
    criticalMax: numberOrNull(row.criticalMax),
  };
}

/** Re-exported so the responder spec can assert the ISO discipline without importing the contract lib twice. */
export { isoOrNull };
