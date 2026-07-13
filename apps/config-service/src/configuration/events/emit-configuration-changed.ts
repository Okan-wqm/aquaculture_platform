import { createBaseEvent, type ConfigurationChangedEvent } from '@platform/event-contracts';
import { OutboxPublisher } from '@platform/outbox';
import { EntityManager } from 'typeorm';

import { Configuration, ConfigValueType } from '../entities/configuration.entity';

/**
 * The single emit path for the metadata-only `ConfigurationChanged` signal
 * (ARCH-MEDIUM-003). EVERY mutating config handler (create / update / delete /
 * upsert) routes through this helper so the event fires on any change — not just
 * upsert — and the payload shape can never drift between handlers.
 *
 * MUST be called inside the handler's active transaction (pass
 * `queryRunner.manager`) so the outbox row commits atomically with the config
 * write: a committed change always emits, a rolled-back one never does. The
 * event carries NO value/secret — only enough metadata for a consumer to decide
 * relevance and invalidate a cache; the secret is fetched on demand via GET_SECRET.
 */
export async function emitConfigurationChanged(
  outbox: OutboxPublisher,
  manager: EntityManager,
  saved: Configuration,
  userId?: string,
): Promise<void> {
  const changedAt =
    saved.updatedAt instanceof Date ? saved.updatedAt : new Date(saved.updatedAt ?? Date.now());
  const event: ConfigurationChangedEvent = {
    ...createBaseEvent<ConfigurationChangedEvent>('ConfigurationChanged', saved.tenantId, {
      userId,
      aggregateId: saved.id,
      aggregateType: 'Configuration',
    }),
    service: saved.service,
    key: saved.key,
    environment: saved.environment,
    valueType: saved.valueType,
    isSecret: saved.isSecret === true || saved.valueType === ConfigValueType.SECRET,
    configVersion: saved.version,
    changedAt: changedAt.toISOString(),
  };
  await outbox.enqueue(event, manager, { aggregateId: saved.id });
}
