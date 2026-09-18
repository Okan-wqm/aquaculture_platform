/**
 * FeedingWindowModule (W7 — FARM-MEDIUM-271)
 *
 * The sensor-side half of the pre-meal oxygen guard. Kept as its own module
 * rather than folded into IngestionModule because it is not an ingestion
 * concern: nothing here writes readings, it only reads them to answer a
 * question the farm engine asked on the wire.
 */
import { Module } from '@nestjs/common';

import { FeedingWindowReadinessService } from './feeding-window-readiness.service';
import { FeedingWindowEventHandler } from './feeding-window.handler';

@Module({
  providers: [FeedingWindowReadinessService, FeedingWindowEventHandler],
  exports: [FeedingWindowReadinessService],
})
export class FeedingWindowModule {}
