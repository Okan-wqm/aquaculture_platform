import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { DeployArtifact } from '../deploy-artifact/entities/deploy-artifact.entity';
import { EdgeDeviceModule } from '../edge-device/edge-device.module';

import { DeployBundleDispatcherService } from './deploy-bundle-dispatcher.service';
import { ReleaseBundle } from './entities/release-bundle.entity';
import { ReleaseBundleService } from './release-bundle.service';

/**
 * Two-phase release bundles (enterprise plan Faz 5): the state-machine
 * service plus the outbox-relay consumer that dispatches committed
 * bundles over MQTT. Imported by ProcessModule (bundle builder) and
 * IngestionModule (edge ack transitions).
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([ReleaseBundle, DeployArtifact]),
    // EdgeCommandPublisher: the single command publish path (ADR-048 DEC-9.2).
    EdgeDeviceModule,
  ],
  providers: [ReleaseBundleService, DeployBundleDispatcherService],
  exports: [ReleaseBundleService],
})
export class ReleaseBundleModule {}
