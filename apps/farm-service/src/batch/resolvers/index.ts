/**
 * Batch Resolvers
 * @module Batch/Resolvers
 */
export * from './batch.resolver';
export * from './cleaner-fish.resolver';

import { BatchResolver } from './batch.resolver';
import { CleanerFishResolver } from './cleaner-fish.resolver';

export const BatchResolvers = [
  BatchResolver,
  CleanerFishResolver,
];
