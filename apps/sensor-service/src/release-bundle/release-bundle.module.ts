import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { DeployArtifact } from '../deploy-artifact/entities/deploy-artifact.entity';
import { EdgeDeviceModule } from '../edge-device/edge-device.module';

import { DeployBundleDispatcherService } from './deploy-bundle-dispatcher.service';
import { EdgeRolloutResolver } from './edge-rollout.resolver';
import { EdgeRolloutService } from './edge-rollout.service';
import { ReleaseBundle } from './entities/release-bundle.entity';
import { ReleaseBundleService } from './release-bundle.service';

/**
 * Two-phase release bundles (enterprise plan Faz 5): the state-machine
 * service plus the outbox-relay consumer that dispatches committed
 * bundles over MQTT. Imported by ProcessModule (bundle builder) and
 * IngestionModule (edge ack transitions).
 *
 * Also the cloud's cohort rollouts of Suderra OS agent releases and OS bundles
 * (ADR-048 DEC-23): the plan, its two-person approval and the waves.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([ReleaseBundle, DeployArtifact]),
    // EdgeCommandPublisher: the single command publish path (ADR-048 DEC-9.2).
    EdgeDeviceModule,
  ],
  providers: [
    ReleaseBundleService,
    DeployBundleDispatcherService,
    // Cohort rollouts of agent releases and OS bundles, two-person approved (DEC-2.4, DEC-23).
    EdgeRolloutService,
    EdgeRolloutResolver,
  ],
  exports: [ReleaseBundleService],
})
export class ReleaseBundleModule {}
