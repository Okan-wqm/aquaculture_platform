import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AutomationProgram } from '../automation/entities/automation-program.entity';
import { Sensor } from '../database/entities/sensor.entity';
import { SimpleRateLimitGuard } from '../guards/rate-limit.guard';
import { PlcAlarm } from '../plc-control/entities/plc-alarm.entity';
// SharedMqttModule is @Global, no need to import explicitly

import { DeviceEventService } from './device-event.service';
import { EdgeDeviceResolver } from './edge-device.resolver';
import { EdgeDeviceService } from './edge-device.service';
import { DeviceIoConfig } from './entities/device-io-config.entity';
import { EdgeDevice } from './entities/edge-device.entity';
import { TenantProvisioningKey } from './entities/tenant-provisioning-key.entity';
import { DeviceEvent } from './entities/device-event.entity';
import { InstallerScriptService } from './installer-script.service';
import { MqttAuthController } from './mqtt-auth.controller';
import { MqttAuthService } from './mqtt-auth.service';
import { ProvisioningController } from './provisioning.controller';
import { ProvisioningService } from './provisioning.service';
import { TenantKeyService } from './tenant-key.service';


@Module({
  imports: [
    TypeOrmModule.forFeature([
      EdgeDevice,
      DeviceIoConfig,
      TenantProvisioningKey,
      DeviceEvent,
      // Additional entities for field resolver counts
      AutomationProgram,
      Sensor,
      PlcAlarm,
    ]),
    // MqttClientService is available via @Global SharedMqttModule
  ],
  controllers: [ProvisioningController, MqttAuthController],
  providers: [
    EdgeDeviceService,
    EdgeDeviceResolver,
    ProvisioningService,
    InstallerScriptService,
    TenantKeyService,
    DeviceEventService,
    MqttAuthService,
    SimpleRateLimitGuard, // Rate limiting for provisioning endpoints
  ],
  exports: [EdgeDeviceService, ProvisioningService, MqttAuthService, InstallerScriptService],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class EdgeDeviceModule {}
