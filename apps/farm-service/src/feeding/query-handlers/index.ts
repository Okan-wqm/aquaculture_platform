/**
 * Feeding Query Handlers Index
 * @module Feeding/QueryHandlers
 */
import { GetFeedingRecordsHandler } from './get-feeding-records.handler';
import { GetFeedInventoryHandler } from './get-feed-inventory.handler';
import { GetFeedingSummaryHandler } from './get-feeding-summary.handler';

export * from './get-feeding-records.handler';
export * from './get-feed-inventory.handler';
export * from './get-feeding-summary.handler';

/**
 * All feeding query handlers for module registration
 */
export const FeedingQueryHandlers = [
  GetFeedingRecordsHandler,
  GetFeedInventoryHandler,
  GetFeedingSummaryHandler,
];
