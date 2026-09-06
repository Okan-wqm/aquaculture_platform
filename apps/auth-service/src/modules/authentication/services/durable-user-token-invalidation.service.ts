import {
  IUserTokenRevocation,
  USER_TOKEN_REVOCATION,
  userInvalidationEpochFromDate,
} from '@aquaculture/backend-common/security';
import { Inject, Injectable } from '@nestjs/common';
import {
  createBaseEvent,
  tenantScopeOf,
  type UserAccessTokenInvalidationReason,
  type UserAccessTokenInvalidationRequestedEvent,
} from '@platform/event-contracts';
import { OutboxPublisher } from '@platform/outbox';
import { EntityManager } from 'typeorm';

export interface UserTokenInvalidationIntent {
  userId: string;
  tenantId: string | null;
  invalidatedAt: Date;
  reason: UserAccessTokenInvalidationReason;
  idempotencyKey: string;
}

/**
 * Durable SSoT for user-wide access-token invalidation.
 *
 * The intent is inserted through the caller's transaction manager so the
 * credential mutation and recovery signal commit atomically. The caller then
 * invokes `applyImmediately` after commit for request-path enforcement; the
 * auth-service consumer replays the same max-only Redis write after outages.
 */
@Injectable()
export class DurableUserTokenInvalidationService {
  constructor(
    private readonly outboxPublisher: OutboxPublisher,
    @Inject(USER_TOKEN_REVOCATION)
    private readonly userTokenRevocation: IUserTokenRevocation,
  ) {}

  async enqueue(manager: EntityManager, intent: UserTokenInvalidationIntent): Promise<void> {
    // Captured inside the credential transaction; replay must never invent a later cutoff.
    await manager.query(
      `UPDATE auth.users SET "accessTokenInvalidBeforeEpochSeconds" =
      GREATEST("accessTokenInvalidBeforeEpochSeconds", $2) WHERE id = $1`,
      [intent.userId, userInvalidationEpochFromDate(intent.invalidatedAt)],
    );
    const scope = tenantScopeOf(intent.tenantId);
    const systemRouted = scope.kind === 'platform';
    const event: UserAccessTokenInvalidationRequestedEvent = {
      ...createBaseEvent<UserAccessTokenInvalidationRequestedEvent>(
        'UserAccessTokenInvalidationRequested',
        scope,
        {
          aggregateId: intent.userId,
          aggregateType: 'User',
        },
      ),
      targetUserId: intent.userId,
      invalidatedAtEpochSeconds: userInvalidationEpochFromDate(intent.invalidatedAt),
      reason: intent.reason,
    };

    await this.outboxPublisher.enqueue(event, manager, {
      aggregateId: intent.userId,
      idempotencyKey: intent.idempotencyKey,
      deliveryPolicy: 'security-recovery',
      ...(systemRouted ? { routingScope: 'system' as const } : {}),
    });
  }

  async applyImmediately(intent: UserTokenInvalidationIntent): Promise<void> {
    await this.userTokenRevocation.revokeUserTokens(intent.userId, intent.invalidatedAt);
  }
}
