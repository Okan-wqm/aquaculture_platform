import { Module } from '@nestjs/common';
import { MetricsAggregatorService } from './metrics-aggregator.service';
import { MetricsAggregatorController } from './metrics-aggregator.controller';

@Module({
  controllers: [MetricsAggregatorController],
  providers: [MetricsAggregatorService],
  exports: [MetricsAggregatorService],
})
export class MetricsAggregatorModule {}
