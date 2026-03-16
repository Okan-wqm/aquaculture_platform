import { Logger } from '@nestjs/common';
import {
  EventSubscriber,
  EntitySubscriberInterface,
  InsertEvent,
  UpdateEvent,
  RemoveEvent,
} from 'typeorm';
import { getRequestContext } from '@platform/backend-common';
import { isAuditable } from './auditable.decorator';

/**
 * Sensitive fields that should never be stored in audit logs.
 * Values for these fields are replaced with '[REDACTED]'.
 */
const SENSITIVE_FIELDS = new Set([
  'password',
  'appKey',
  'clientPrivateKey',
  'clientCertificate',
  'serverCertificate',
  'provisioningToken',
  'mqttPasswordHash',
]);

/**
 * Redact sensitive fields from an object before persisting to audit_logs.
 */
function redactSensitiveFields(
  obj: Record<string, unknown> | null | undefined,
): Record<string, unknown> | undefined {
  if (!obj) return undefined;

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    result[key] = SENSITIVE_FIELDS.has(key) ? '[REDACTED]' : value;
  }
  return result;
}

/**
 * Compute which fields changed between old and new entity snapshots.
 * Returns the list of field names whose values differ.
 */
function computeChangedFields(
  oldValues: Record<string, unknown>,
  newValues: Record<string, unknown>,
): string[] {
  const changed: string[] = [];
  const allKeys = new Set([...Object.keys(oldValues), ...Object.keys(newValues)]);

  for (const key of allKeys) {
    const oldVal = oldValues[key];
    const newVal = newValues[key];
    // Use JSON comparison for nested objects/arrays
    if (JSON.stringify(oldVal) !== JSON.stringify(newVal)) {
      changed.push(key);
    }
  }

  return changed;
}

/**
 * Serialize an entity instance to a plain object, omitting TypeORM
 * internal relation proxies that are not loaded.
 */
function entityToPlain(entity: object): Record<string, unknown> {
  const plain: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entity)) {
    // Skip relation proxy objects (LazyRelationsWrapper etc.)
    if (value !== null && typeof value === 'object' && '__promise__' in value) {
      continue;
    }
    plain[key] = value;
  }
  return plain;
}

@EventSubscriber()
export class AuditSubscriber implements EntitySubscriberInterface {
  private readonly logger = new Logger(AuditSubscriber.name);

  // No listenTo() — subscribe to all entities; we filter by @Auditable() ourselves.

  async afterInsert(event: InsertEvent<object>): Promise<void> {
    if (!isAuditable(event.metadata.target as Function)) return;

    try {
      const entity = event.entity as Record<string, unknown>;
      const tenantId = entity['tenantId'] as string | undefined;
      const entityId = entity['id'] as string | undefined;

      if (!tenantId || !entityId) return;

      const userId = getRequestContext().userId ?? null;
      const newValue = redactSensitiveFields(entityToPlain(event.entity));

      await event.queryRunner.query(
        `INSERT INTO audit_logs
           (id, tenant_id, entity_type, entity_id, action, new_value, changed_by, changed_at)
         VALUES
           (gen_random_uuid(), $1, $2, $3, 'INSERT', $4, $5, NOW())`,
        [tenantId, event.metadata.name, entityId, JSON.stringify(newValue), userId],
      );
    } catch (err) {
      this.logger.error(
        `AuditSubscriber.afterInsert failed for ${event.metadata.name}: ${(err as Error).message}`,
        (err as Error).stack,
      );
    }
  }

  async afterUpdate(event: UpdateEvent<object>): Promise<void> {
    if (!event.entity) return;
    if (!isAuditable(event.metadata.target as Function)) return;

    try {
      const entity = event.entity as Record<string, unknown>;
      const tenantId = entity['tenantId'] as string | undefined;
      const entityId = entity['id'] as string | undefined;

      if (!tenantId || !entityId) return;

      const userId = getRequestContext().userId ?? null;

      const oldValues = event.databaseEntity
        ? entityToPlain(event.databaseEntity as object)
        : {};
      const newValues = entityToPlain(event.entity as object);

      const changedFields = computeChangedFields(oldValues, newValues);
      if (changedFields.length === 0) return;

      const previousValue = redactSensitiveFields(oldValues);
      const newValue = redactSensitiveFields(newValues);

      await event.queryRunner.query(
        `INSERT INTO audit_logs
           (id, tenant_id, entity_type, entity_id, action,
            previous_value, new_value, changed_fields, changed_by, changed_at)
         VALUES
           (gen_random_uuid(), $1, $2, $3, 'UPDATE', $4, $5, $6, $7, NOW())`,
        [
          tenantId,
          event.metadata.name,
          entityId,
          JSON.stringify(previousValue),
          JSON.stringify(newValue),
          JSON.stringify(changedFields),
          userId,
        ],
      );
    } catch (err) {
      this.logger.error(
        `AuditSubscriber.afterUpdate failed for ${event.metadata.name}: ${(err as Error).message}`,
        (err as Error).stack,
      );
    }
  }

  async afterRemove(event: RemoveEvent<object>): Promise<void> {
    if (!isAuditable(event.metadata.target as Function)) return;

    try {
      // databaseEntity holds the entity state before deletion
      const entity = (event.databaseEntity ?? event.entity) as Record<string, unknown> | undefined;
      if (!entity) return;

      const tenantId = entity['tenantId'] as string | undefined;
      const entityId = entity['id'] as string | undefined;

      if (!tenantId || !entityId) return;

      const userId = getRequestContext().userId ?? null;
      const previousValue = redactSensitiveFields(entityToPlain(entity as object));

      await event.queryRunner.query(
        `INSERT INTO audit_logs
           (id, tenant_id, entity_type, entity_id, action, previous_value, changed_by, changed_at)
         VALUES
           (gen_random_uuid(), $1, $2, $3, 'DELETE', $4, $5, NOW())`,
        [tenantId, event.metadata.name, entityId, JSON.stringify(previousValue), userId],
      );
    } catch (err) {
      this.logger.error(
        `AuditSubscriber.afterRemove failed for ${event.metadata.name}: ${(err as Error).message}`,
        (err as Error).stack,
      );
    }
  }
}
