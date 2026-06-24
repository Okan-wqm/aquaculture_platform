import { Logger } from '@nestjs/common';
import {
  EventSubscriber,
  EntitySubscriberInterface,
  InsertEvent,
  UpdateEvent,
  RemoveEvent,
} from 'typeorm';
import { getRequestContext } from '@aquaculture/backend-common/logging';
import { SENSITIVE_FIELDS_SET } from '@aquaculture/backend-common/security';
import { isAuditable } from './auditable.decorator';

/**
 * Redact sensitive fields from an object before persisting to sensor_audit_logs.
 */
function redactSensitiveFields(
  obj: Record<string, unknown> | null | undefined,
): Record<string, unknown> | undefined {
  if (!obj) return undefined;

  /** SEC-L15: Use shared SENSITIVE_FIELDS_SET for consistent PII redaction across all services. */
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    result[key] = SENSITIVE_FIELDS_SET.has(key) ? '[REDACTED]' : value;
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

/**
 * AuditSubscriber — entity-mutation audit stream for the sensor service.
 *
 * # Why this lives alongside the canonical shared.audit_logs stream
 *   (AUDITTRAIL-MEDIUM-004 cure)
 *
 * The platform exposes TWO audit streams by deliberate design:
 *
 *   - **Semantic-action stream** (`shared.audit_logs`): emitted by
 *     `@AuditedOperation`-decorated handlers via the canonical
 *     AuditedOperationInterceptor. Rows describe what a USER /
 *     ACTOR DID at the application semantic level — `CREATE_FARM`,
 *     `ASSIGN_ROLE`, `IMPERSONATION_START`. One row per business
 *     action; row carries actorHomeTenantId, actorActedOnTenantId,
 *     method, mfaVerified, result, preStateHash, postStateHash,
 *     justification, relatedAuditIds (the AUDITTRAIL-CRITICAL-004
 *     mandatory shape). SOC 2 CC1, GDPR Art 30, PCI-DSS § 10
 *     evidence consumers query this stream.
 *
 *   - **Entity-mutation stream** (`sensor_audit_logs`, this
 *     subscriber): emitted by TypeORM at the persistence boundary.
 *     Rows describe what HAPPENED TO AN ENTITY ROW at the storage
 *     level — INSERT/UPDATE/DELETE with previous_value, new_value,
 *     changed_fields. One row per entity mutation; high-throughput
 *     ingestion paths (sensor readings, calibration deltas) emit
 *     thousands of these per second under normal load. The auditor's
 *     "outbox exception" allows this stream to bypass the
 *     synchronous audit interceptor — the volume would otherwise
 *     stall the audit-row pipeline.
 *
 * # Why the shapes do NOT (and should not) align
 *
 * Forcing the entity-mutation stream into the 22-column canonical
 * shape would either:
 *
 *   - Lose information specific to entity mutations (changed_fields,
 *     previous_value JSONB diff) that the canonical shape doesn't
 *     model; OR
 *   - Force every entity-mutation row to fabricate semantic-action
 *     fields (action='ENTITY_INSERT', result='SUCCESS', method=null)
 *     that have no meaning at the entity-mutation tier — degrading
 *     the canonical stream's signal-to-noise.
 *
 * # Cross-service forensic queries
 *
 * When an investigator needs both streams (e.g. "what semantic
 * action triggered this entity mutation?"), the join uses
 * (tenantId, correlationId) as the bridging key:
 *
 *     SELECT s.action, s.userId, e.entity_type, e.changed_fields
 *     FROM shared.audit_logs s
 *     JOIN sensor_audit_logs e
 *       ON s."tenantId" = e.tenant_id
 *      AND s."correlationId" = e.correlation_id  -- TODO: see below
 *     WHERE s."createdAt" BETWEEN $1 AND $2;
 *
 * # What is NOT done in this commit (next-batch tracked)
 *
 * The bridging `correlation_id` column on `sensor_audit_logs` is
 * NOT present today — TypeORM subscribers don't have the
 * correlation_id from the request context wired through. Adding it
 * is a column migration + propagation through `getRequestContext().
 * correlationId` plumbing on the INSERT statements below. Tracked
 * as the AUDITTRAIL-MEDIUM-004 follow-up; the divergence-by-design
 * closure is the architectural decision, the bridging-column wiring
 * is the implementation follow-on.
 *
 * # Failure mode
 *
 * Each handler still wraps its INSERT in try/catch (legacy shape).
 * Unlike the semantic-action stream's fail-closed posture
 * (AUDITTRAIL-HIGH-002 cure), entity-mutation audits use the agent's
 * outbox exception — silent loss is acceptable on the high-throughput
 * path because (a) each row carries its own forensic value
 * proportional to the mutation rate, and (b) failing the underlying
 * entity write because the audit-shadow write failed would cascade
 * into ingestion-pipeline outages on a hot-path. If outbox-style
 * durability is required for a particular subset of entities, those
 * entities should be promoted to the @Auditable + canonical-stream
 * path explicitly.
 */
@EventSubscriber()
export class AuditSubscriber implements EntitySubscriberInterface {
  private readonly logger = new Logger(AuditSubscriber.name);

  // No listenTo() — subscribe to all entities; we filter by @Auditable() ourselves.

  async afterInsert(event: InsertEvent<object>): Promise<void> {
    const target = event.metadata.target;
    if (typeof target !== 'function' || !isAuditable(target)) return;

    try {
      const entity = event.entity as Record<string, unknown>;
      const tenantId = entity['tenantId'] as string | undefined;
      const entityId = entity['id'] as string | undefined;

      if (!tenantId || !entityId) return;

      const userId = getRequestContext().userId ?? null;
      const newValue = redactSensitiveFields(entityToPlain(event.entity));

      await event.queryRunner.query(
        `INSERT INTO sensor_audit_logs
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
    const target = event.metadata.target;
    if (typeof target !== 'function' || !isAuditable(target)) return;

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
        `INSERT INTO sensor_audit_logs
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
    const target = event.metadata.target;
    if (typeof target !== 'function' || !isAuditable(target)) return;

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
        `INSERT INTO sensor_audit_logs
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
