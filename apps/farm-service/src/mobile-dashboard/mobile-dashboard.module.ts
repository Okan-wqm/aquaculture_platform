import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MortalityRecord } from '../batch/entities/mortality-record.entity';
import { TankOperation } from '../batch/entities/tank-operation.entity';
import { DailyFeedingExecution } from '../feeding/entities/daily-feeding-execution.entity';
import { WaterQualityMeasurement } from '../water-quality/entities/water-quality-measurement.entity';
import { MobileDashboardResolver } from './mobile-dashboard.resolver';
// Read query handlers (fail-closed tenant boundary — FARM-HIGH-060)
import { GetTodaysDailyOpsCountsHandler } from './handlers/get-todays-daily-ops-counts.handler';
import { GetStockEventsSummaryHandler } from './handlers/get-stock-events-summary.handler';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      MortalityRecord,
      WaterQualityMeasurement,
      DailyFeedingExecution,
      TankOperation,
    ]),
  ],
  providers: [
    MobileDashboardResolver,
    GetTodaysDailyOpsCountsHandler,
    GetStockEventsSummaryHandler,
  ],
})
export class MobileDashboardModule {}
