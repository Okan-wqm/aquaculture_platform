/**
 * Growth Query Handlers Index
 * @module Growth/QueryHandlers
 */
import { GetGrowthMeasurementsHandler } from './get-growth-measurements.handler';
import { GetGrowthAnalysisHandler } from './get-growth-analysis.handler';
import { GetLatestMeasurementHandler } from './get-latest-measurement.handler';

export * from './get-growth-measurements.handler';
export * from './get-growth-analysis.handler';
export * from './get-latest-measurement.handler';

/**
 * All growth query handlers for module registration
 */
export const GrowthQueryHandlers = [
  GetGrowthMeasurementsHandler,
  GetGrowthAnalysisHandler,
  GetLatestMeasurementHandler,
];
