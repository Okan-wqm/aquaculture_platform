import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { IngestionModule } from '../ingestion/ingestion.module';

import { EdgeDeviceResolver } from './edge-device.resolver';
import { EdgeDeviceService } from './edge-device.service';
import { DeviceIoConfig } from './entities/device-io-config.entity';
import { EdgeDevice } from './entities/edge-device.entity';
import { MqttAuthService } from './mqtt-auth.service';
import { ProvisioningController } from './provisioning.controller';
import { ProvisioningService } from './provisioning.service';


@Module({
  imports: [
    TypeOrmModule.forFeature([EdgeDevice, DeviceIoConfig]),
    forwardRef(() => IngestionModule), // For MQTT command publishing
  ],
  controllers: [ProvisioningController],
  providers: [
    EdgeDeviceService,
    EdgeDeviceResolver,
    ProvisioningService,
    MqttAuthService,
  ],
  exports: [EdgeDeviceService, ProvisioningService, MqttAuthService],
})
export class EdgeDeviceModule {}
