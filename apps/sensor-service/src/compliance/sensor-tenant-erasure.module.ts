import { Module } from '@nestjs/common';

import { EdgeDeviceModule } from '../edge-device/edge-device.module';
import { IngestionModule } from '../ingestion/ingestion.module';
import { SensorTenantErasureHook } from './sensor-tenant-erasure.hook';

@Module({
  imports: [IngestionModule, EdgeDeviceModule],
  providers: [SensorTenantErasureHook],
  exports: [SensorTenantErasureHook],
})
export class SensorTenantErasureModule {}
