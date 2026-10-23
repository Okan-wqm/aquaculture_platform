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
import { EdgeDeviceResultResolver } from './edge-result.resolver';
import { EdgeResultTelemetryService } from './edge-result-telemetry.service';
import { EdgeDeviceResolver } from './edge-device.resolver';
import { EdgeDeviceService } from './edge-device.service';
import { DeviceIoConfig } from './entities/device-io-config.entity';
import { EdgeDeviceDirectory } from './entities/edge-device-directory.entity';
import { EdgeDevice } from './entities/edge-device.entity';
import { LoRaDevice } from './entities/lora-device.entity';
import { TenantProvisioningKeyDirectory } from './entities/tenant-provisioning-key-directory.entity';
import { TenantProvisioningKey } from './entities/tenant-provisioning-key.entity';
import { DeviceEvent } from './entities/device-event.entity';
import { EdgeDeviceResult } from './entities/edge-device-result.entity';
import { EdgeUpdateRequest } from './entities/edge-update-request.entity';
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
import { CommandEnvelopeSignerService } from './command-envelope-signer.service';
import { DeviceLifecycleStatementService } from './device-lifecycle-statement.service';
import { EdgeCommandPublisher } from './edge-command-publisher.service';
import { EdgeRootHandoffService } from './edge-root-handoff.service';
import { EdgeProvisioningManifestService } from './edge-provisioning-manifest.service';
import { EdgeUpdateManifestService } from './edge-update-manifest.service';
import { EdgeUpdateReconciler } from './edge-update-reconciler.service';
import { EdgeUpdateRequestService } from './edge-update-request.service';
import {
  EdgeReleaseCatalog,
  fetchReleaseStatement,
  RELEASE_PROVENANCE_VERIFIER,
  RELEASE_STATEMENT_FETCHER,
} from './edge-release-catalog.service';
import { verifyReleaseProvenance } from './edge-release-provenance';
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
      EdgeDeviceResult,
      EdgeUpdateRequest,
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
    { provide: RELEASE_PROVENANCE_VERIFIER, useValue: verifyReleaseProvenance },
    EdgeProvisioningManifestService,
    // The device-bound edge-update and os-update statements (DEC-2.4, DEC-2.9).
    EdgeUpdateManifestService,
    EdgeUpdateRequestService,
    // Lapses silent requests and re-issues retryable ones on a schedule (DEC-2.12).
    EdgeUpdateReconciler,
    ProvisioningReservationService,
    // The single command publish path (ADR-048 DEC-9.2) and its signer.
    CommandEnvelopeSignerService,
    EdgeCommandPublisher,
    EdgeRootHandoffService,
    // Typed install/update results from the device's results topic (DEC-27).
    EdgeResultTelemetryService,
    EdgeDeviceResultResolver,
  ],
  exports: [
    EdgeDeviceService,
    ProvisioningService,
    MqttAuthService,
    InstallerScriptService,
    DeviceDirectoryService,
    EdgeCommandPublisher,
    EdgeResultTelemetryService,
    EdgeUpdateRequestService,
    EdgeReleaseCatalog,
  ],
})
export class EdgeDeviceModule {}
