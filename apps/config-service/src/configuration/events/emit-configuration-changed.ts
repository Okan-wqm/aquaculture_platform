import { CONFIGURATION_CATALOG_DIGEST } from '@aquaculture/configuration-contracts';
import { createBaseEvent, type ConfigurationChangedEvent } from '@platform/event-contracts';
import { OutboxPublisher } from '@platform/outbox';
import { EntityManager } from 'typeorm';

import { Configuration } from '../entities/configuration.entity';

/** Emit catalog identity only; values and duplicated key metadata never cross the outbox. */
export async function emitConfigurationChanged(
  outbox: OutboxPublisher,
  manager: EntityManager,
  saved: Configuration,
  userId: string,
): Promise<void> {
  const changedAt =
    saved.updatedAt instanceof Date ? saved.updatedAt : new Date(saved.updatedAt ?? Date.now());
  const event: ConfigurationChangedEvent = {
    ...createBaseEvent<ConfigurationChangedEvent>('ConfigurationChanged', saved.tenantId, {
      userId,
      aggregateId: saved.id,
      aggregateType: 'Configuration',
    }),
    catalogId: saved.catalogId,
    catalogDigest: CONFIGURATION_CATALOG_DIGEST,
    environment: saved.environment,
    configVersion: saved.version,
    changedAt: changedAt.toISOString(),
  };
  await outbox.enqueue(event, manager, { aggregateId: saved.id });
}
