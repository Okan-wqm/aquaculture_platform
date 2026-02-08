/**
 * Feeding Resolvers
 * @module Feeding/Resolvers
 */
export * from './feeding.resolver';
export * from './feeding-program.resolver';

import { FeedingResolver, FeedInventoryResolver } from './feeding.resolver';
import { FeedingProgramResolver } from './feeding-program.resolver';

export const FeedingResolvers = [
  FeedingResolver,
  FeedInventoryResolver,
  FeedingProgramResolver,
];
