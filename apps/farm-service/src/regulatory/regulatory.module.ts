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

@Module({
  imports: [
    ConfigModule,
    TypeOrmModule.forFeature([RegulatorySettings, BiomassReport]),
  ],
  providers: [
    MaskinportenService,
    MattilsynetApiService,
    RegulatoryResolver,
    RegulatorySettingsService,
    BiomassReportService,
    BiomassReportResolver,
    RegulatorySettingsSeederService,
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
