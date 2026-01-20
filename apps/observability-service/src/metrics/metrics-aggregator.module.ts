import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { MetricsAggregatorService } from './metrics-aggregator.service';
import { MetricsAggregatorController } from './metrics-aggregator.controller';

@Module({
  imports: [ScheduleModule.forRoot()],
  controllers: [MetricsAggregatorController],
  providers: [MetricsAggregatorService],
  exports: [MetricsAggregatorService],
})
export class MetricsAggregatorModule {}
