import { Global, Module } from '@nestjs/common';
import { OutboxModule } from '@platform/outbox';

import { AccessTokenInvalidationHandler } from '../modules/authentication/controllers/access-token-invalidation.handler';
import { UserAccessTokenInvalidationHandler } from '../modules/authentication/controllers/user-access-token-invalidation.handler';
import { DurableAccessTokenInvalidationService } from '../modules/authentication/services/durable-access-token-invalidation.service';
import { DurableUserTokenInvalidationService } from '../modules/authentication/services/durable-user-token-invalidation.service';
import { AuthOutbox } from './auth-outbox.entity';
import { BestEffortEventPublisher } from './best-effort-event-publisher';

/**
 * @module AuthOutboxModule
 * @description Single registration point for the auth-service transactional
 * outbox (DATA-HIGH-001).
 *
 * Wraps `OutboxModule.forFeature(AuthOutbox)` from @platform/outbox so the
 * OutboxWorkerService (poll + NATS publish + retry/dead-letter), the
 * OutboxPublisher (validated transactional enqueue), the metrics service, and
 * the LISTEN/NOTIFY low-latency listener all run exactly once in the
 * auth-service process.
 *
 * @Global() — OutboxPublisher is cross-cutting infrastructure. The tenant,
 * authentication, account, privacy, and provisioning services inject it
 * directly to enqueue domain events inside their write transaction, without
 * each feature module re-importing the outbox.
 */
@Global()
@Module({
  imports: [
    OutboxModule.forFeature(AuthOutbox, {
      allowSystemRouting: true,
      allowSecurityRecovery: true,
    }),
  ],
  providers: [
    BestEffortEventPublisher,
    DurableAccessTokenInvalidationService,
    DurableUserTokenInvalidationService,
    AccessTokenInvalidationHandler,
    UserAccessTokenInvalidationHandler,
  ],
  exports: [
    OutboxModule,
    BestEffortEventPublisher,
    DurableAccessTokenInvalidationService,
    DurableUserTokenInvalidationService,
    AccessTokenInvalidationHandler,
    UserAccessTokenInvalidationHandler,
  ],
})
export class AuthOutboxModule {}
