/**
 * PURE projections for the water-quality farm-AI responder (PR-3).
 *
 * Rules of the read-only namespace (see ai-query-responder.ts):
 *  - Input = the query handler's return shape; output = wire DTO ONLY.
 *  - NO entity metadata (createdAt/updatedAt/tenantId) and NO operator PII
 *    (measuredBy, notes, sensorInfo, summary blobs …) — the AI persona
 *    answers about water, never about people.
 *  - Dates → ISO strings (or null); numbers keep their unit in the name.
 */
import { WaterQualityMeasurement } from '../entities/water-quality-measurement.entity';
import { WaterQualityParameterConfig } from '../entities/water-quality-parameter-config.entity';
import { WaterQualityStatsResult } from '../query-handlers/water-quality-stats.result';
import { isoOrNull } from '../../common/nats/ai-query-responder';

/** One measurement's operator-facing numbers (quick-access fields only). */
export interface WqMeasurementPointDto {
  id: string;
  measuredAt: string | null;
  temperatureC: number | null;
  dissolvedOxygenMgL: number | null;
  ph: number | null;
  ammoniaMgL: number | null;
  nitriteMgL: number | null;
  overallStatus: string;
}

/** Project a chart/history/critical measurement row. */
export function projectWaterQualityMeasurement(
  row: Pick<
    WaterQualityMeasurement,
    | 'id'
    | 'measuredAt'
    | 'temperature'
    | 'dissolvedOxygen'
    | 'pH'
    | 'ammonia'
    | 'nitrite'
    | 'overallStatus'
  >,
): WqMeasurementPointDto {
  return {
    id: row.id,
    measuredAt: isoOrNull(row.measuredAt),
    temperatureC: row.temperature ?? null,
    dissolvedOxygenMgL: row.dissolvedOxygen ?? null,
    ph: row.pH ?? null,
    ammoniaMgL: row.ammonia ?? null,
    nitriteMgL: row.nitrite ?? null,
    overallStatus: String(row.overallStatus),
  };
}

/** Aggregate statistics DTO (tank + system share the shape). */
export interface WqStatsDto {
  windowDays: number;
  avgTemperatureC: number | null;
  avgDissolvedOxygenMgL: number | null;
  avgPh: number | null;
  avgAmmoniaMgL: number | null;
  avgNitriteMgL: number | null;
  measurementCount: number;
  criticalCount: number;
  warningCount: number;
  lastMeasurement: WqMeasurementPointDto | null;
}

/** Project the WaterQualityStatsResult returned by both stats handlers. */
export function projectWaterQualityStats(
  result: WaterQualityStatsResult,
  windowDays: number,
): WqStatsDto {
  return {
    windowDays,
    avgTemperatureC: result.avgTemperature,
    avgDissolvedOxygenMgL: result.avgDO,
    avgPh: result.avgPH,
    avgAmmoniaMgL: result.avgAmmonia,
    avgNitriteMgL: result.avgNitrite,
    measurementCount: result.measurementCount,
    criticalCount: result.criticalCount,
    warningCount: result.warningCount,
    lastMeasurement: result.lastMeasurement
      ? projectWaterQualityMeasurement(result.lastMeasurement)
      : null,
  };
}

/** Critical-tanks row (latest measurement per tank, tank identity attached). */
export interface CriticalWaterQualityDto extends WqMeasurementPointDto {
  tankId: string | null;
  tankCode: string | null;
  tankName: string | null;
  hasAlarm: boolean;
}

/**
 * Project a critical-WQ row. The handler eager-loads `tank`; only its stable
 * identity fields (code/name) cross the wire.
 */
export function projectCriticalWaterQuality(row: WaterQualityMeasurement): CriticalWaterQualityDto {
  return {
    ...projectWaterQualityMeasurement(row),
    tankId: row.tankId ?? null,
    tankCode: row.tank?.code ?? null,
    tankName: row.tank?.name ?? null,
    hasAlarm: row.hasAlarm === true,
  };
}

/** Parameter-config (threshold) DTO. */
export interface WqThresholdDto {
  id: string;
  code: string;
  name: string;
  unit: string;
  dataType: string;
  group: string;
  optimalMin: number | null;
  optimalMax: number | null;
  warningMin: number | null;
  warningMax: number | null;
  criticalMin: number | null;
  criticalMax: number | null;
  isActive: boolean;
  isVisible: boolean;
}

/**
 * Project a tenant parameter-config row. When the request narrowed to one
 * `speciesId`, the species-specific override for exactly that species is
 * inlined (the caller has no other way to key the speciesLimits map).
 */
export function projectWaterQualityThreshold(
  config: WaterQualityParameterConfig,
  speciesId?: string,
): WqThresholdDto {
  const speciesLimit =
    speciesId && config.speciesLimits ? config.speciesLimits[speciesId] : undefined;
  return {
    id: config.id,
    code: config.code,
    name: config.name,
    unit: config.unit,
    dataType: String(config.dataType),
    group: String(config.group),
    optimalMin: speciesLimit?.optimalMin ?? config.optimalMin ?? null,
    optimalMax: speciesLimit?.optimalMax ?? config.optimalMax ?? null,
    warningMin: speciesLimit?.warningMin ?? config.warningMin ?? null,
    warningMax: speciesLimit?.warningMax ?? config.warningMax ?? null,
    criticalMin: speciesLimit?.criticalMin ?? config.criticalMin ?? null,
    criticalMax: speciesLimit?.criticalMax ?? config.criticalMax ?? null,
    isActive: config.isActive === true,
    isVisible: config.isVisible === true,
  };
}
