/**
 * Batch Handlers Index
 * @module Batch/Handlers
 */
import { AllocateToTankHandler } from './allocate-to-tank.handler';
import { CloseBatchHandler } from './close-batch.handler';
import { CreateBatchHandler } from './create-batch.handler';
import { CreateCleanerBatchHandler } from './create-cleaner-batch.handler';
import { DeleteBatchHandler } from './delete-batch.handler';
import { DeployCleanerFishHandler } from './deploy-cleaner-fish.handler';
import { RecordCleanerMortalityHandler } from './record-cleaner-mortality.handler';
import { RecordCullHandler } from './record-cull.handler';
import { RecordGradingHandler } from './record-grading.handler';
import { RecordMortalityHandler } from './record-mortality.handler';
import { RemoveCleanerFishHandler } from './remove-cleaner-fish.handler';
import { TransferBatchHandler } from './transfer-batch.handler';
import { TransferCleanerFishHandler } from './transfer-cleaner-fish.handler';
import { UpdateBatchStatusHandler } from './update-batch-status.handler';
import { UpdateBatchHandler } from './update-batch.handler';

export * from './create-batch.handler';
export * from './create-cleaner-batch.handler';
export * from './delete-batch.handler';
export * from './deploy-cleaner-fish.handler';
export * from './record-cleaner-mortality.handler';
export * from './record-cull.handler';
export * from './record-grading.handler';
export * from './record-mortality.handler';
export * from './remove-cleaner-fish.handler';
export * from './transfer-batch.handler';
export * from './transfer-cleaner-fish.handler';
export * from './update-batch.handler';
export * from './update-batch-status.handler';
export * from './allocate-to-tank.handler';
export * from './close-batch.handler';

/**
 * All batch command handlers for module registration
 */
export const BatchCommandHandlers = [
  CreateBatchHandler,
  UpdateBatchHandler,
  UpdateBatchStatusHandler,
  RecordMortalityHandler,
  RecordCullHandler,
  RecordGradingHandler,
  CloseBatchHandler,
  AllocateToTankHandler,
  TransferBatchHandler,
  DeleteBatchHandler,
  // Cleaner Fish Handlers
  CreateCleanerBatchHandler,
  DeployCleanerFishHandler,
  RecordCleanerMortalityHandler,
  TransferCleanerFishHandler,
  RemoveCleanerFishHandler,
];
