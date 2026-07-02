/**
 * Regulatory Module
 *
 * Module for Norwegian regulatory reporting services.
 * Provides:
 * - Tenant-specific regulatory settings management (company info, Maskinporten credentials)
 * - Integration with Mattilsynet APIs via Maskinporten OAuth2
 *
 * Settings are stored per-tenant in tenant-specific schemas (schema-level isolation).
 */

import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MaskinportenService } from './maskinporten.service';
import { MattilsynetApiService } from './mattilsynet-api.service';
import { RegulatoryResolver } from './regulatory.resolver';
import { RegulatorySettings } from './entities/regulatory-settings.entity';
import { RegulatorySettingsService } from './regulatory-settings.service';
import { BiomassReport } from './entities/biomass-report.entity';
import { BiomassReportService } from './services/biomass-report.service';
import { BiomassReportResolver } from './biomass-report.resolver';
import { RegulatorySettingsSeederService } from './services/regulatory-settings-seeder.service';
import { RegulatoryVarslingService } from './services/regulatory-varsling.service';
import { RegulatoryReport } from './entities/regulatory-report.entity';
import { RegulatoryReportStoreService } from './services/regulatory-report-store.service';
import { RegulatoryReportResolver } from './regulatory-report.resolver';

// Biomass-report read handlers (fail-closed tenant boundary — FARM-HIGH-060)
import { GetBiomassReportByPeriodHandler } from './handlers/get-biomass-report-by-period.handler';
import { ListBiomassReportsForSiteHandler } from './handlers/list-biomass-reports-for-site.handler';

// Regulatory-report read handlers (FARM-HIGH-112)
import { ListRegulatoryReportsHandler } from './handlers/list-regulatory-reports.handler';
import { GetRegulatoryReportHandler } from './handlers/get-regulatory-report.handler';
import { GetRegulatoryReportSummaryHandler } from './handlers/get-regulatory-report-summary.handler';

@Module({
  imports: [
    ConfigModule,
    TypeOrmModule.forFeature([RegulatorySettings, BiomassReport, RegulatoryReport]),
  ],
  providers: [
    MaskinportenService,
    MattilsynetApiService,
    RegulatoryResolver,
    RegulatorySettingsService,
    BiomassReportService,
    BiomassReportResolver,
    GetBiomassReportByPeriodHandler,
    ListBiomassReportsForSiteHandler,
    RegulatorySettingsSeederService,
    RegulatoryVarslingService,
    RegulatoryReportStoreService,
    RegulatoryReportResolver,
    ListRegulatoryReportsHandler,
    GetRegulatoryReportHandler,
    GetRegulatoryReportSummaryHandler,
  ],
  exports: [
    MaskinportenService,
    MattilsynetApiService,
    RegulatorySettingsService,
    BiomassReportService,
    RegulatorySettingsSeederService,
  ],
})
export class RegulatoryModule {}
