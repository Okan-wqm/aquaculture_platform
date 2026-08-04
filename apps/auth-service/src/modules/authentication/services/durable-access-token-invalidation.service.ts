import { ITokenBlacklist, TOKEN_BLACKLIST } from '@aquaculture/backend-common/security';
import { Inject, Injectable } from '@nestjs/common';
import {
  createBaseEvent,
  type AccessTokenInvalidationReason,
  type AccessTokenInvalidationRequestedEvent,
} from '@platform/event-contracts';
import { OUTBOX_SYSTEM_TENANT_ID, OutboxPublisher } from '@platform/outbox';
import { EntityManager } from 'typeorm';

export interface AccessTokenInvalidationIntent {
  targetJti: string;
  tenantId: string | null;
  expiresAt: Date;
  reason: AccessTokenInvalidationReason;
  idempotencyKey: string;
}

/** Durable counterpart of the auth-owned per-JTI Redis blacklist write. */
@Injectable()
export class DurableAccessTokenInvalidationService {
  constructor(
    private readonly outboxPublisher: OutboxPublisher,
    @Inject(TOKEN_BLACKLIST) private readonly tokenBlacklist: ITokenBlacklist,
  ) {}

  async enqueue(manager: EntityManager, intent: AccessTokenInvalidationIntent): Promise<void> {
    const systemRouted = intent.tenantId === null;
    const expiresAtEpochSeconds = Math.floor(intent.expiresAt.getTime() / 1000);
    if (!Number.isSafeInteger(expiresAtEpochSeconds) || expiresAtEpochSeconds <= 0) {
      throw new RangeError('Invalid access-token expiry date');
    }
    const event: AccessTokenInvalidationRequestedEvent = {
      ...createBaseEvent<AccessTokenInvalidationRequestedEvent>(
        'AccessTokenInvalidationRequested',
        intent.tenantId ?? OUTBOX_SYSTEM_TENANT_ID,
        { aggregateId: intent.targetJti, aggregateType: 'AccessToken' },
      ),
      targetJti: intent.targetJti,
      expiresAtEpochSeconds,
      reason: intent.reason,
    };
    await this.outboxPublisher.enqueue(event, manager, {
      aggregateId: intent.targetJti,
      idempotencyKey: intent.idempotencyKey,
      deliveryPolicy: 'security-recovery',
      ...(systemRouted ? { routingScope: 'system' as const } : {}),
    });
  }

  async applyImmediately(intent: AccessTokenInvalidationIntent): Promise<void> {
    await this.tokenBlacklist.add(intent.targetJti, intent.expiresAt, intent.reason);
  }
}
