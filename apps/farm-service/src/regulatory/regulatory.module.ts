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

@Module({
  imports: [
    ConfigModule,
    TypeOrmModule.forFeature([RegulatorySettings]),
  ],
  providers: [
    MaskinportenService,
    MattilsynetApiService,
    RegulatoryResolver,
    RegulatorySettingsService,
  ],
  exports: [
    MaskinportenService,
    MattilsynetApiService,
    RegulatorySettingsService,
  ],
})
export class RegulatoryModule {}
