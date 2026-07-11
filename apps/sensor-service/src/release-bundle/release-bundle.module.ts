import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { DeployArtifact } from '../deploy-artifact/entities/deploy-artifact.entity';

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
  imports: [TypeOrmModule.forFeature([ReleaseBundle, DeployArtifact])],
  providers: [ReleaseBundleService, DeployBundleDispatcherService],
  exports: [ReleaseBundleService],
})
export class ReleaseBundleModule {}
