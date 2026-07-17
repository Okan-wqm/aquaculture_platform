/**
 * Feeding Resolvers
 * @module Feeding/Resolvers
 */
export * from './feeding.resolver';
export * from './feeding-program.resolver';

import { FeedingResolver } from './feeding.resolver';
import { FeedingProgramResolver } from './feeding-program.resolver';

export const FeedingResolvers = [
  FeedingResolver,
  FeedingProgramResolver,
];
