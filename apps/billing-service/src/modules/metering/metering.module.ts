/**
 * Metering Module
 *
 * Usage tracking, aggregation, and metered billing services.
 */

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EventEmitterModule } from '@nestjs/event-emitter';

// Entities
import { UsageAggregation, UsageHourlyData } from './entities/usage-aggregation.entity';

// Services
import { UsageMeteringService } from './usage-metering.service';
import { UsageAggregatorService } from './usage-aggregator.service';
import { MeteredBillingService } from './metered-billing.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([UsageAggregation, UsageHourlyData]),
    EventEmitterModule.forRoot(),
  ],
  providers: [
    UsageMeteringService,
    UsageAggregatorService,
    MeteredBillingService,
  ],
  exports: [
    UsageMeteringService,
    UsageAggregatorService,
    MeteredBillingService,
    TypeOrmModule,
  ],
})
export class MeteringModule {}
