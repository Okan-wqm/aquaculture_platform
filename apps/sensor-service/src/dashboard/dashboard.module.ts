import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { DashboardResolver } from './dashboard.resolver';
import { DashboardService } from './dashboard.service';
import { DashboardLayout } from './entities/dashboard-layout.entity';

@Module({
  imports: [TypeOrmModule.forFeature([DashboardLayout])],
  providers: [DashboardService, DashboardResolver],
  exports: [DashboardService],
})
export class DashboardModule {}
