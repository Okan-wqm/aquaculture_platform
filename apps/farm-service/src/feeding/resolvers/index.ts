/**
 * Feeding Resolvers
 * @module Feeding/Resolvers
 */
export * from './feeding.resolver';

import { FeedingResolver, FeedInventoryResolver } from './feeding.resolver';

export const FeedingResolvers = [
  FeedingResolver,
  FeedInventoryResolver,
];
