import { Module } from '@nestjs/common';
import { SystemMetricsService } from './system-metrics.service';
import { SystemMetricsController } from './system-metrics.controller';

@Module({
  controllers: [SystemMetricsController],
  providers: [SystemMetricsService],
  exports: [SystemMetricsService],
})
export class SystemMetricsModule {}
