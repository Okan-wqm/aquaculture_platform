/**
 * Analytics Module
 *
 * Dashboard analytics and catalog-governed report execution module.
 * Report artifacts remain fail-closed until every measurement authority has
 * an exact adapter; legacy dashboard metric remediation is tracked separately.
 */

import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';
import { COMPILED_REPORT_AUTHORITY_GRAPH } from '@platform/reporting-contracts';

import { AuditLogModule } from '../audit/audit.module';
import { COMPILED_REPORT_MEASUREMENT_ADAPTER_BUILD_ATTESTATION_SET } from '../bootstrap/report-measurement-adapter-build-attestations.generated';

import { AnalyticsController } from './controllers/analytics.controller';
import { ReportsController } from './controllers/reports.controller';
import {
  AnalyticsSnapshot,
  ReportDefinition,
  ReportExecution,
} from './entities/analytics-snapshot.entity';
import { InvoiceReadOnly } from './entities/external/invoice.entity';
import { SubscriptionReadOnly } from './entities/external/subscription.entity';
import { TenantReadOnly } from './entities/external/tenant.entity';
import { UserReadOnly } from './entities/external/user.entity';
import { AnalyticsSnapshotScheduler } from './services/analytics-snapshot.scheduler';
import {
  REPORT_COMPILED_AUTHORITY_GRAPH,
  REPORT_MEASUREMENT_ADAPTER_BUILD_ATTESTATIONS,
  REPORT_MEASUREMENT_ADAPTERS,
  ReportMeasurementAdapterRegistry,
} from './services/report-measurement-adapter.registry';
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
    ]),
    ScheduleModule,
    AuditLogModule,
  ],
  controllers: [AnalyticsController, ReportsController],
  providers: [
    AnalyticsService,
    ReportsService,
    AnalyticsSnapshotScheduler,
    {
      provide: REPORT_COMPILED_AUTHORITY_GRAPH,
      useValue: COMPILED_REPORT_AUTHORITY_GRAPH,
    },
    {
      provide: REPORT_MEASUREMENT_ADAPTERS,
      useValue: Object.freeze([]),
    },
    {
      provide: REPORT_MEASUREMENT_ADAPTER_BUILD_ATTESTATIONS,
      useValue: COMPILED_REPORT_MEASUREMENT_ADAPTER_BUILD_ATTESTATION_SET.attestations,
    },
    ReportMeasurementAdapterRegistry,
  ],
  exports: [AnalyticsService, ReportsService],
})
export class AnalyticsModule {
  readonly moduleName = AnalyticsModule.name;
}
