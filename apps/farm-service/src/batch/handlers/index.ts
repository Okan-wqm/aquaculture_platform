/**
 * Batch Handlers Index
 * @module Batch/Handlers
 */
import { CreateBatchHandler } from './create-batch.handler';
import { UpdateBatchHandler } from './update-batch.handler';
import { UpdateBatchStatusHandler } from './update-batch-status.handler';
import { RecordMortalityHandler } from './record-mortality.handler';
import { RecordCullHandler } from './record-cull.handler';
import { CloseBatchHandler } from './close-batch.handler';
import { AllocateToTankHandler } from './allocate-to-tank.handler';
import { TransferBatchHandler } from './transfer-batch.handler';

// Cleaner Fish Handlers
import { CreateCleanerBatchHandler } from './create-cleaner-batch.handler';
import { DeployCleanerFishHandler } from './deploy-cleaner-fish.handler';
import { RecordCleanerMortalityHandler } from './record-cleaner-mortality.handler';
import { TransferCleanerFishHandler } from './transfer-cleaner-fish.handler';
import { RemoveCleanerFishHandler } from './remove-cleaner-fish.handler';

export * from './create-batch.handler';
export * from './update-batch.handler';
export * from './update-batch-status.handler';
export * from './record-mortality.handler';
export * from './record-cull.handler';
export * from './close-batch.handler';
export * from './allocate-to-tank.handler';
export * from './transfer-batch.handler';

// Cleaner Fish exports
export * from './create-cleaner-batch.handler';
export * from './deploy-cleaner-fish.handler';
export * from './record-cleaner-mortality.handler';
export * from './transfer-cleaner-fish.handler';
export * from './remove-cleaner-fish.handler';

/**
 * All batch command handlers for module registration
 */
export const BatchCommandHandlers = [
  CreateBatchHandler,
  UpdateBatchHandler,
  UpdateBatchStatusHandler,
  RecordMortalityHandler,
  RecordCullHandler,
  CloseBatchHandler,
  AllocateToTankHandler,
  TransferBatchHandler,
  // Cleaner Fish Handlers
  CreateCleanerBatchHandler,
  DeployCleanerFishHandler,
  RecordCleanerMortalityHandler,
  TransferCleanerFishHandler,
  RemoveCleanerFishHandler,
];
