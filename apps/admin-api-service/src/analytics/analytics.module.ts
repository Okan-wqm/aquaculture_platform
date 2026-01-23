/**
 * Analytics Module
 *
 * Dashboard KPI, metrik hesaplama ve rapor oluşturma modülü.
 * Uses real database queries to calculate metrics - NO MOCK DATA.
 */

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';

// Entities
import { AnalyticsSnapshot, ReportDefinition, ReportExecution } from './entities/analytics-snapshot.entity';

// External Entities (read-only references to other services' data)
import { TenantReadOnly } from './entities/external/tenant.entity';
import { UserReadOnly } from './entities/external/user.entity';
import { SubscriptionReadOnly } from './entities/external/subscription.entity';
import { InvoiceReadOnly } from './entities/external/invoice.entity';

// Services
import { AnalyticsService } from './services/analytics.service';
import { ReportsService } from './services/reports.service';

// Controllers
import { AnalyticsController } from './controllers/analytics.controller';
import { ReportsController } from './controllers/reports.controller';

// Audit Module for activity heatmap
import { AuditLogModule } from '../audit/audit.module';

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
    ]),
    ScheduleModule.forRoot(),
    AuditLogModule,
  ],
  controllers: [AnalyticsController, ReportsController],
  providers: [AnalyticsService, ReportsService],
  exports: [AnalyticsService, ReportsService],
})
export class AnalyticsModule {}
