import { Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';

import { CreateFeedingRecordHandler } from '../feeding/handlers/create-feeding-record.handler';
import { UpdateFeedingRecordHandler } from '../feeding/handlers/update-feeding-record.handler';
import { ForecastRefreshListener } from './listeners/forecast-refresh.listener';
import { FeedForecastResolver } from './resolvers/feed-forecast.resolver';
import { MealExecutionResolver } from './resolvers/meal-execution.resolver';
import { FeedingOperationControlPlaneModule } from './feeding-operation-control-plane.module';
import { FEEDING_MUTATION_RUNTIME_AUTHORITY_PROVIDER } from './feeding-mutation-runtime.authority';

/**
 * Presentation and timer ingress. This is the only layer allowed to depend on
 * the control-plane composition root; no executor imports this module.
 */
@Module({
  imports: [DiscoveryModule, FeedingOperationControlPlaneModule],
  providers: [
    CreateFeedingRecordHandler,
    UpdateFeedingRecordHandler,
    ForecastRefreshListener,
    FeedForecastResolver,
    MealExecutionResolver,
    FEEDING_MUTATION_RUNTIME_AUTHORITY_PROVIDER,
  ],
})
export class FeedingOperationIngressModule {}
