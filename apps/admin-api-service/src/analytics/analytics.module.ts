/**
 * Analytics Module
 *
 * Dashboard KPI, metrik hesaplama ve rapor oluşturma modülü.
 * Uses real database queries to calculate metrics - NO MOCK DATA.
 */

import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuditLogModule } from '../audit/audit.module';

import { AnalyticsController } from './controllers/analytics.controller';
import { ReportsController } from './controllers/reports.controller';
import { AnalyticsSnapshot, ReportDefinition, ReportExecution } from './entities/analytics-snapshot.entity';
import { InvoiceReadOnly } from './entities/external/invoice.entity';
import { PaymentReadOnly } from './entities/external/payment.entity';
import { ScheduledPlanChangeReadOnly } from './entities/external/scheduled-plan-change.entity';
import { SubscriptionReadOnly } from './entities/external/subscription.entity';
import { TenantReadOnly } from './entities/external/tenant.entity';
import { UserReadOnly } from './entities/external/user.entity';
import { AnalyticsSnapshotScheduler } from './services/analytics-snapshot.scheduler';
import { AnalyticsService } from './services/analytics.service';
import { ReportsService } from './services/reports.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      AnalyticsSnapshot,
      ReportDefinition,
      ReportExecution,
      // External entities for cross-service analytics
      // These are read-only - source of truth is in their respective services
      TenantReadOnly,
      UserReadOnly,
      SubscriptionReadOnly,
      InvoiceReadOnly,
      // The plan-change ledger and the payment refunds are the only DATED
      // records of an upgrade and of a reversal; without them the revenue
      // report had to hardcode zeros (APA-139).
      ScheduledPlanChangeReadOnly,
      PaymentReadOnly,
    ]),
    ScheduleModule,
    AuditLogModule,
  ],
  controllers: [AnalyticsController, ReportsController],
  providers: [AnalyticsService, ReportsService, AnalyticsSnapshotScheduler],
  exports: [AnalyticsService, ReportsService],
})
export class AnalyticsModule {
  readonly moduleName = AnalyticsModule.name;
}
