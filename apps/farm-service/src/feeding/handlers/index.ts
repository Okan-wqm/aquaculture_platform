/**
 * Feeding Handlers Index
 * @module Feeding/Handlers
 */
import { CreateFeedingRecordHandler } from './create-feeding-record.handler';
import { UpdateFeedingRecordHandler } from './update-feeding-record.handler';

export * from './create-feeding-record.handler';
export * from './update-feeding-record.handler';

/**
 * All feeding command handlers for module registration
 */
export const FeedingCommandHandlers = [CreateFeedingRecordHandler, UpdateFeedingRecordHandler];
