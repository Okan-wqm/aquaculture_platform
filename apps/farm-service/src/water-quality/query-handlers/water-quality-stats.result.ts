/**
 * Shared aggregate-statistics result shape for tank + system water-quality
 * statistics handlers (single SSoT — both handlers return this exact shape,
 * which structurally matches the GraphQL WaterQualityStatistics ObjectType).
 */
import { WaterQualityMeasurement } from '../entities/water-quality-measurement.entity';

export interface WaterQualityStatsResult {
  avgTemperature: number | null;
  avgDO: number | null;
  avgPH: number | null;
  avgAmmonia: number | null;
  avgNitrite: number | null;
  measurementCount: number;
  criticalCount: number;
  warningCount: number;
  lastMeasurement: WaterQualityMeasurement | null;
}
