import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { SensorServiceProfileService } from './sensor-service-profile.service';

/**
 * Sensor-service-local config module.
 *
 * Currently exports just the [`SensorServiceProfileService`] (ADR-022)
 * which gates the data-plane shape. Held in its own module so other
 * sensor-service modules (`IngestionModule` etc.) can import it without
 * pulling in unrelated providers or hitting circular-dep traps.
 */
@Module({
  imports: [ConfigModule],
  providers: [SensorServiceProfileService],
  exports: [SensorServiceProfileService],
})
 
export class SensorServiceConfigModule {}
