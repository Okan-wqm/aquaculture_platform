import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MortalityRecord } from '../batch/entities/mortality-record.entity';
import { TankOperation } from '../batch/entities/tank-operation.entity';
import { DailyFeedingExecution } from '../feeding/entities/daily-feeding-execution.entity';
import { WaterQualityMeasurement } from '../water-quality/entities/water-quality-measurement.entity';
import { MobileDashboardResolver } from './mobile-dashboard.resolver';
import { MobileDashboardService } from './mobile-dashboard.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      MortalityRecord,
      WaterQualityMeasurement,
      DailyFeedingExecution,
      TankOperation,
    ]),
  ],
  providers: [MobileDashboardResolver, MobileDashboardService],
})
export class MobileDashboardModule {}
