import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { SimpleRateLimitGuard } from '../guards/rate-limit.guard';
// SharedMqttModule is @Global, no need to import explicitly

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
    // MqttClientService is available via @Global SharedMqttModule
  ],
  controllers: [ProvisioningController],
  providers: [
    EdgeDeviceService,
    EdgeDeviceResolver,
    ProvisioningService,
    MqttAuthService,
    SimpleRateLimitGuard, // Rate limiting for provisioning endpoints
  ],
  exports: [EdgeDeviceService, ProvisioningService, MqttAuthService],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class EdgeDeviceModule {}
