import { Module } from '@nestjs/common';

import { FeedingModule } from '../feeding/feeding.module';
import { FeedingProtocolModule } from './feeding-protocol.module';
import { FEEDING_OPERATION_HANDLER_ADAPTER_PROVIDER } from './feeding-operation-handler.adapter';
import { FEEDING_OPERATION_COMMAND_PORT } from './feeding-operation-command.port';
import { FEEDING_OPERATION_PRIVATE_PROVIDERS } from './services/feeding-operation-coordinator.service';
import { FeedingTimezoneAuthorityService } from './services/feeding-timezone-authority.service';

/**
 * One DI boundary for every feeding mutation authority.
 *
 * Domain modules point only into this composition root; the control plane
 * never imports an ingress provider, so the dependency graph is acyclic.
 */
@Module({
  imports: [FeedingModule, FeedingProtocolModule],
  providers: [
    ...FEEDING_OPERATION_PRIVATE_PROVIDERS,
    FeedingTimezoneAuthorityService,
    FEEDING_OPERATION_HANDLER_ADAPTER_PROVIDER,
  ],
  exports: [FEEDING_OPERATION_COMMAND_PORT],
})
export class FeedingOperationControlPlaneModule {}
