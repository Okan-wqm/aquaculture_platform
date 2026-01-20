/**
 * Growth Handlers Index
 * @module Growth/Handlers
 */
import { RecordGrowthSampleHandler } from './record-growth-sample.handler';
import { UpdateBatchWeightFromSampleHandler } from './update-batch-weight-from-sample.handler';
import { VerifyMeasurementHandler } from './verify-measurement.handler';

export * from './record-growth-sample.handler';
export * from './update-batch-weight-from-sample.handler';
export * from './verify-measurement.handler';

/**
 * All growth command handlers for module registration
 */
export const GrowthCommandHandlers = [
  RecordGrowthSampleHandler,
  UpdateBatchWeightFromSampleHandler,
  VerifyMeasurementHandler,
];
