/**
 * Feeding Handlers Index
 * @module Feeding/Handlers
 */
import { CreateFeedingRecordHandler } from './create-feeding-record.handler';
import { UpdateFeedingRecordHandler } from './update-feeding-record.handler';
import { AddFeedInventoryHandler } from './add-feed-inventory.handler';
import { ConsumeFeedInventoryHandler } from './consume-feed-inventory.handler';
import { AdjustFeedInventoryHandler } from './adjust-feed-inventory.handler';

export * from './create-feeding-record.handler';
export * from './update-feeding-record.handler';
export * from './add-feed-inventory.handler';
export * from './consume-feed-inventory.handler';
export * from './adjust-feed-inventory.handler';

/**
 * All feeding command handlers for module registration
 */
export const FeedingCommandHandlers = [
  CreateFeedingRecordHandler,
  UpdateFeedingRecordHandler,
  AddFeedInventoryHandler,
  ConsumeFeedInventoryHandler,
  AdjustFeedInventoryHandler,
];
