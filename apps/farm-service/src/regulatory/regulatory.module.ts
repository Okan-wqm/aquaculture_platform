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

import { BatchModule } from '../batch/batch.module';
import { Site } from '../site/entities/site.entity';
import { MaskinportenService } from './maskinporten.service';
import { MattilsynetApiService } from './mattilsynet-api.service';
import { MattilsynetSchemaValidatorService } from './services/mattilsynet-schema-validator.service';
import { RegulatoryResolver } from './regulatory.resolver';
import { RegulatorySettings } from './entities/regulatory-settings.entity';
import { RegulatorySettingsService } from './regulatory-settings.service';
import { BiomassReport } from './entities/biomass-report.entity';
import { BiomassReportService } from './services/biomass-report.service';
import { BiomassAltinnExportService } from './services/biomass-altinn-export.service';
import { BiomassReportResolver } from './biomass-report.resolver';
import { RegulatorySettingsSeederService } from './services/regulatory-settings-seeder.service';
import { RegulatoryVarslingService } from './services/regulatory-varsling.service';
import { RegulatoryReport } from './entities/regulatory-report.entity';
import { RegulatoryReportStoreService } from './services/regulatory-report-store.service';
import { RegulatoryReportResolver } from './regulatory-report.resolver';
import { SlaughterFacility } from './entities/slaughter-facility.entity';
import { RegulatoryReportDraft } from './entities/regulatory-report-draft.entity';
import { SlaughterFacilityService } from './services/slaughter-facility.service';
import { SlaughterFacilityResolver } from './resolvers/slaughter-facility.resolver';
import { ListSlaughterFacilitiesHandler } from './handlers/list-slaughter-facilities.handler';

// Biomass-report read handlers (fail-closed tenant boundary — FARM-HIGH-060)
import { GetBiomassReportByPeriodHandler } from './handlers/get-biomass-report-by-period.handler';
import { ListBiomassReportsForSiteHandler } from './handlers/list-biomass-reports-for-site.handler';

// Server-side report assembly (automated-reporting plan Phase 1)
import { BiomassReportAssembler } from './assembly/biomass.assembler';
import { LakselusReportAssembler } from './assembly/assemblers/lakselus.assembler';
import { RensefiskReportAssembler } from './assembly/assemblers/rensefisk.assembler';
import { SettefiskReportAssembler } from './assembly/assemblers/settefisk.assembler';
import { SlaktReportAssembler } from './assembly/assemblers/slakt.assembler';
import { WaterTemperatureService } from '../water-quality/services/water-temperature.service';
import { ReportAssemblyService } from './assembly/report-assembly.service';
import { GetReportPrefillHandler } from './handlers/get-report-prefill.handler';
import { ReportPrefillResolver } from './report-prefill.resolver';
import { ReportSchedulerService } from './services/report-scheduler.service';
import { RegulatorySubmissionService } from './services/regulatory-submission.service';
import { RegulatoryReportDraftService } from './services/regulatory-report-draft.service';
import { RegulatoryDraftSubmissionService } from './services/regulatory-draft-submission.service';
import { RegulatoryReportDraftResolver } from './regulatory-report-draft.resolver';

// Regulatory-report read handlers (FARM-HIGH-125)
import { ListRegulatoryReportsHandler } from './handlers/list-regulatory-reports.handler';
import { GetRegulatoryReportHandler } from './handlers/get-regulatory-report.handler';
import { GetRegulatoryReportSummaryHandler } from './handlers/get-regulatory-report-summary.handler';

@Module({
  imports: [
    ConfigModule,
    TypeOrmModule.forFeature([
      RegulatorySettings,
      BiomassReport,
      RegulatoryReport,
      SlaughterFacility,
      RegulatoryReportDraft,
      Site,
    ]),
    // BiomassCalculatorService (exported by BatchModule) is the standing-stock
    // SSoT the biomass assembler reads (RPT-012 dedup verdict).
    BatchModule,
  ],
  providers: [
    MaskinportenService,
    MattilsynetApiService,
    MattilsynetSchemaValidatorService,
    RegulatoryResolver,
    RegulatorySettingsService,
    BiomassReportService,
    BiomassAltinnExportService,
    BiomassReportResolver,
    GetBiomassReportByPeriodHandler,
    ListBiomassReportsForSiteHandler,
    RegulatorySettingsSeederService,
    RegulatoryVarslingService,
    RegulatoryReportStoreService,
    RegulatoryReportResolver,
    SlaughterFacilityService,
    SlaughterFacilityResolver,
    ListSlaughterFacilitiesHandler,
    ListRegulatoryReportsHandler,
    GetRegulatoryReportHandler,
    GetRegulatoryReportSummaryHandler,
    BiomassReportAssembler,
    LakselusReportAssembler,
    SettefiskReportAssembler,
    RensefiskReportAssembler,
    SlaktReportAssembler,
    // Same local-provider pattern feeding.module/equipment.module use — the
    // service only injects DataSource; no module cycle with water-quality.
    WaterTemperatureService,
    ReportAssemblyService,
    GetReportPrefillHandler,
    ReportPrefillResolver,
    ReportSchedulerService,
    RegulatorySubmissionService,
    RegulatoryReportDraftService,
    RegulatoryDraftSubmissionService,
    RegulatoryReportDraftResolver,
  ],
  exports: [
    MaskinportenService,
    MattilsynetApiService,
    MattilsynetSchemaValidatorService,
    RegulatorySettingsService,
    BiomassReportService,
    RegulatorySettingsSeederService,
    SlaughterFacilityService,
  ],
})
export class RegulatoryModule {}
