import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EdgeDevice } from './entities/edge-device.entity';
import { DeviceIoConfig } from './entities/device-io-config.entity';
import { EdgeDeviceService } from './edge-device.service';
import { EdgeDeviceResolver } from './edge-device.resolver';
import { ProvisioningService } from './provisioning.service';
import { ProvisioningController } from './provisioning.controller';
import { MqttAuthService } from './mqtt-auth.service';
import { IngestionModule } from '../ingestion/ingestion.module';

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
