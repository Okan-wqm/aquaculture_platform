/**
 * Batch Query Handlers Index
 * @module Batch/QueryHandlers
 */
import { GetBatchHandler } from './get-batch.handler';
import { ListBatchesHandler } from './list-batches.handler';
import { ListAvailableTanksHandler } from './list-available-tanks.handler';
import { GenerateBatchNumberHandler } from './generate-batch-number.handler';
import { GetBatchPerformanceHandler } from './get-batch-performance.handler';
import { GetBatchHistoryHandler } from './get-batch-history.handler';

export * from './get-batch.handler';
export * from './list-batches.handler';
export * from './list-available-tanks.handler';
export * from './generate-batch-number.handler';
export * from './get-batch-performance.handler';
export * from './get-batch-history.handler';

/**
 * All batch query handlers for module registration
 */
export const BatchQueryHandlers = [
  GetBatchHandler,
  ListBatchesHandler,
  ListAvailableTanksHandler,
  GenerateBatchNumberHandler,
  GetBatchPerformanceHandler,
  GetBatchHistoryHandler,
];
