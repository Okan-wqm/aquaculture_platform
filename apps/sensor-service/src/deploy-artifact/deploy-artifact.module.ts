import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ArtifactService } from './artifact.service';
import { DeploySigningService } from './deploy-signing.service';
import { DeployArtifact } from './entities/deploy-artifact.entity';

/**
 * Content-addressed deploy artifact store (enterprise plan Faz 3) +
 * ed25519 deploy signer (Faz 4). Imported by ProcessModule (SCADA
 * package + process deploys) and AutomationModule (program deploys) —
 * its own module keeps the dependency graph acyclic between those two.
 */
@Module({
  imports: [TypeOrmModule.forFeature([DeployArtifact])],
  providers: [ArtifactService, DeploySigningService],
  exports: [ArtifactService, DeploySigningService],
})
export class DeployArtifactModule {}
