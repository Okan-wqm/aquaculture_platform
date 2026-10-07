/**
 * Localization — the tenant's localization projection and the one resolver of
 * which zone a site's day is counted in (SiteTimeZoneService). Feeding imports
 * it; sensor-service reaches it through `request.farm.resolveTimeZones`.
 */
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { TenantLocalization } from './entities/tenant-localization.entity';
import { TenantLocalizationProjectionListener } from './listeners/tenant-localization-projection.listener';
import { ResolveTimeZonesResponder } from './responders/resolve-time-zones.responder';
import { SiteTimeZoneService } from './services/site-time-zone.service';

@Module({
  imports: [TypeOrmModule.forFeature([TenantLocalization])],
  providers: [SiteTimeZoneService, TenantLocalizationProjectionListener, ResolveTimeZonesResponder],
  exports: [SiteTimeZoneService],
})
export class LocalizationModule {}
