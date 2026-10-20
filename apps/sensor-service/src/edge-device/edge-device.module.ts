import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AutomationProgram } from '../automation/entities/automation-program.entity';
import { Sensor } from '../database/entities/sensor.entity';
import { SimpleRateLimitGuard } from '../guards/rate-limit.guard';
import { PlcAlarm } from '../plc-control/entities/plc-alarm.entity';
// SharedMqttModule is @Global, no need to import explicitly

import { DeviceDirectoryService } from './device-directory.service';
import { DeviceEventService } from './device-event.service';
import { EdgeDeviceNatsController } from './edge-device-nats.controller';
import { EdgeDeviceResolver } from './edge-device.resolver';
import { EdgeDeviceService } from './edge-device.service';
import { DeviceIoConfig } from './entities/device-io-config.entity';
import { EdgeDeviceDirectory } from './entities/edge-device-directory.entity';
import { EdgeDevice } from './entities/edge-device.entity';
import { LoRaDevice } from './entities/lora-device.entity';
import { TenantProvisioningKeyDirectory } from './entities/tenant-provisioning-key-directory.entity';
import { TenantProvisioningKey } from './entities/tenant-provisioning-key.entity';
import { DeviceEvent } from './entities/device-event.entity';
import {
  EdgeAuditArchiveV2,
  EdgeDeviceV2,
  EdgeFirmwareReleaseV2,
  EdgeLicenseV2,
  EdgePolicyV2,
  EdgeProvisioningRecordV2,
  EdgeWitnessV2,
} from './entities/v2';
import { ActivationReceiptService } from './activation-receipt.service';
import { DeviceLifecycleStatementService } from './device-lifecycle-statement.service';
import { EdgeProvisioningManifestService } from './edge-provisioning-manifest.service';
import {
  EdgeReleaseCatalog,
  fetchReleaseStatement,
  RELEASE_STATEMENT_FETCHER,
} from './edge-release-catalog.service';
import { InstallerScriptService } from './installer-script.service';
import { MqttAuthController } from './mqtt-auth.controller';
import { MqttAuthService } from './mqtt-auth.service';
import { ProvisioningController } from './provisioning.controller';
import { ProvisioningReservationService } from './provisioning-reservation.service';
import { ProvisioningService } from './provisioning.service';
import { RbacManifestService } from './rbac-manifest.service';
import { SiteConfigManifestService } from './site-config-manifest.service';
import { SuderraEdgeConfig } from './suderra-edge.config';
import { TenantKeyService } from './tenant-key.service';
import { TrustAnchorBundleService } from './trust-anchor-bundle.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      EdgeDevice,
      EdgeDeviceDirectory,
      EdgeDeviceV2,
      EdgePolicyV2,
      EdgeLicenseV2,
      EdgeFirmwareReleaseV2,
      EdgeProvisioningRecordV2,
      EdgeWitnessV2,
      EdgeAuditArchiveV2,
      DeviceIoConfig,
      LoRaDevice,
      TenantProvisioningKey,
      TenantProvisioningKeyDirectory,
      DeviceEvent,
      // Additional entities for field resolver counts
      AutomationProgram,
      Sensor,
      PlcAlarm,
    ]),
    // MqttClientService is available via @Global SharedMqttModule
  ],
  controllers: [ProvisioningController, MqttAuthController, EdgeDeviceNatsController],
  providers: [
    EdgeDeviceService,
    EdgeDeviceResolver,
    ProvisioningService,
    InstallerScriptService,
    TenantKeyService,
    DeviceEventService,
    DeviceDirectoryService,
    MqttAuthService,
    SimpleRateLimitGuard, // Rate limiting for provisioning endpoints
    // Suderra edge contract (ADR-048): the channel configuration, the
    // statement producers and the two-phase provisioning token.
    SuderraEdgeConfig,
    TrustAnchorBundleService,
    RbacManifestService,
    SiteConfigManifestService,
    DeviceLifecycleStatementService,
    ActivationReceiptService,
    EdgeReleaseCatalog,
    { provide: RELEASE_STATEMENT_FETCHER, useValue: fetchReleaseStatement },
    EdgeProvisioningManifestService,
    ProvisioningReservationService,
  ],
  exports: [
    EdgeDeviceService,
    ProvisioningService,
    MqttAuthService,
    InstallerScriptService,
    DeviceDirectoryService,
  ],
})
export class EdgeDeviceModule {}
