import { randomUUID } from 'node:crypto';

import { getTenantSchemaName } from '@aquaculture/backend-common/database';
import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import {
  createBaseEvent,
  type TelemetryCapacityActivationState,
  type TelemetryCapacityEntitlementChangedEvent,
} from '@platform/event-contracts';
import { OutboxPublisher } from '@platform/outbox';
import { DataSource, EntityManager } from 'typeorm';

export interface ReserveTelemetryCapacityRequest {
  operationId: string;
  tenantId: string;
  sustainedIngressMessagesPerSecond: number;
  sustainedMetricRowsPerMinute: number;
  effectiveAt: Date;
}

export interface TelemetryCapacityEntitlementSnapshot {
  operationId: string;
  tenantId: string;
  reservationId: string;
  entitlementId: string;
  entitlementVersion: number;
  activationState: TelemetryCapacityActivationState;
  effectiveAt: Date;
  capacityEnvelopeVersion: number;
  sustainedIngressMessagesPerSecond: number;
  sustainedMetricRowsPerMinute: number;
}

export interface CreateTelemetryCapacityEnvelopeRequest {
  sustainedIngressMessagesPerSecond: number;
  sustainedMetricRowsPerMinute: number;
  effectiveAt: Date;
  createdBy: string;
}

export interface TelemetryCapacityEnvelopeSnapshot {
  id: string;
  version: number;
  sustainedIngressMessagesPerSecond: number;
  sustainedMetricRowsPerMinute: number;
  effectiveAt: Date;
}

interface EntitlementRow {
  operationId: string;
  tenantId: string;
  reservationId: string;
  entitlementId: string;
  entitlementVersion: number | string;
  activationState: TelemetryCapacityActivationState;
  effectiveAt: Date | string;
  capacityEnvelopeVersion: number | string;
  sustainedIngressMessagesPerSecond: number | string;
  sustainedMetricRowsPerMinute: number | string;
}

interface EnvelopeRow {
  id: string;
  version: number | string;
  ingressLimit: number | string;
  rowLimit: number | string;
}

interface CurrentEntitlementRow {
  sustainedIngressMessagesPerSecond: number | string;
  sustainedMetricRowsPerMinute: number | string;
}

interface CapacityTotalsRow {
  ingress: number | string | null;
  rows: number | string | null;
}

interface VersionRow {
  version: number | string;
}

interface InsertedEntitlementRow {
  entitlementId: string;
  reservationId: string;
}

interface ActivationPrerequisiteRow {
  hypertableReady: boolean;
  caggCount: number | string;
}

interface CreatedEnvelopeRow {
  id: string;
  version: number | string;
  sustainedIngressMessagesPerSecond: number | string;
  sustainedMetricRowsPerMinute: number | string;
  effectiveAt: Date | string;
}

@Injectable()
export class TelemetryCapacityService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly outboxPublisher: OutboxPublisher,
  ) {}

  async reserve(
    request: ReserveTelemetryCapacityRequest,
  ): Promise<TelemetryCapacityEntitlementSnapshot> {
    this.assertValidRequest(request);
    return this.dataSource.transaction('SERIALIZABLE', (manager) =>
      this.reserveWithinTransaction(request, manager),
    );
  }

  async createEnvelope(
    request: CreateTelemetryCapacityEnvelopeRequest,
  ): Promise<TelemetryCapacityEnvelopeSnapshot> {
    this.assertPositiveCapacity(
      request.sustainedIngressMessagesPerSecond,
      request.sustainedMetricRowsPerMinute,
      request.effectiveAt,
    );
    if (request.createdBy.trim().length === 0) {
      throw new Error('Telemetry capacity envelope requires an actor');
    }

    return this.dataSource.transaction('SERIALIZABLE', async (manager) => {
      const currentRows = await manager.query<VersionRow[]>(
        `SELECT /* capacity_envelope_for_revision */ version
         FROM admin.telemetry_capacity_envelopes
         WHERE state = 'ACTIVE'
         ORDER BY version DESC
         LIMIT 1
         FOR UPDATE`,
      );
      const current = currentRows.at(0);
      const version = current === undefined ? 1 : this.toFiniteNumber(current.version) + 1;
      await manager.query(
        `/* SUPERSEDED telemetry_capacity_envelopes */
         UPDATE admin.telemetry_capacity_envelopes
         SET state = 'SUPERSEDED'
         WHERE state = 'ACTIVE'`,
      );
      const rows = await manager.query<CreatedEnvelopeRow[]>(
        `INSERT INTO admin.telemetry_capacity_envelopes (
           id,
           version,
           state,
           sustained_ingress_messages_per_second,
           sustained_metric_rows_per_minute,
           effective_at,
           created_by
         ) VALUES ($1, $2, 'ACTIVE', $3, $4, $5, $6)
         RETURNING
           id,
           version,
           sustained_ingress_messages_per_second AS "sustainedIngressMessagesPerSecond",
           sustained_metric_rows_per_minute AS "sustainedMetricRowsPerMinute",
           effective_at AS "effectiveAt"`,
        [
          randomUUID(),
          version,
          request.sustainedIngressMessagesPerSecond,
          request.sustainedMetricRowsPerMinute,
          request.effectiveAt,
          request.createdBy,
        ],
      );
      const row = rows.at(0);
      if (row === undefined) {
        throw new Error('Telemetry capacity envelope insert returned no row');
      }
      const envelope: TelemetryCapacityEnvelopeSnapshot = {
        id: row.id,
        version: this.toFiniteNumber(row.version),
        sustainedIngressMessagesPerSecond: this.toFiniteNumber(
          row.sustainedIngressMessagesPerSecond,
        ),
        sustainedMetricRowsPerMinute: this.toFiniteNumber(row.sustainedMetricRowsPerMinute),
        effectiveAt: row.effectiveAt instanceof Date ? row.effectiveAt : new Date(row.effectiveAt),
      };
      await this.promotePendingEntitlements(envelope, manager);
      return envelope;
    });
  }

  async reserveWithinTransaction(
    request: ReserveTelemetryCapacityRequest,
    manager: EntityManager,
  ): Promise<TelemetryCapacityEntitlementSnapshot> {
    this.assertValidRequest(request);
    const existingRows = await manager.query<EntitlementRow[]>(
      `SELECT
         entitlement.operation_id AS "operationId",
         entitlement.tenant_id AS "tenantId",
         entitlement.reservation_id AS "reservationId",
         entitlement.entitlement_id AS "entitlementId",
         entitlement.entitlement_version AS "entitlementVersion",
         activation.activation_state AS "activationState",
         entitlement.effective_at AS "effectiveAt",
         entitlement.capacity_envelope_version AS "capacityEnvelopeVersion",
         entitlement.sustained_ingress_messages_per_second AS "sustainedIngressMessagesPerSecond",
         entitlement.sustained_metric_rows_per_minute AS "sustainedMetricRowsPerMinute"
       FROM admin.telemetry_capacity_entitlements entitlement
       JOIN LATERAL (
         SELECT event.activation_state
         FROM admin.telemetry_capacity_activation_events event
         WHERE event.entitlement_id = entitlement.entitlement_id
         ORDER BY event.created_at DESC, event.id DESC
         LIMIT 1
       ) activation ON true
       WHERE entitlement.operation_id = $1
       LIMIT 1`,
      [request.operationId],
    );
    const existing = existingRows.at(0);
    if (existing !== undefined) {
      return this.toSnapshot(existing);
    }

    const envelopeRows = await manager.query<EnvelopeRow[]>(
      `SELECT
         id,
         version,
         sustained_ingress_messages_per_second AS "ingressLimit",
         sustained_metric_rows_per_minute AS "rowLimit"
       FROM admin.telemetry_capacity_envelopes
       WHERE state = 'ACTIVE' AND effective_at <= $1
       ORDER BY version DESC
       LIMIT 1
       FOR UPDATE`,
      [request.effectiveAt],
    );
    const envelope = envelopeRows.at(0);
    if (envelope === undefined) {
      throw new Error('No active telemetry capacity envelope is effective');
    }

    const activeRows = await manager.query<CurrentEntitlementRow[]>(
      `SELECT /* current_tenant_entitlement */
         entitlement.sustained_ingress_messages_per_second AS "sustainedIngressMessagesPerSecond",
         entitlement.sustained_metric_rows_per_minute AS "sustainedMetricRowsPerMinute"
       FROM admin.telemetry_capacity_entitlements entitlement
       JOIN LATERAL (
         SELECT event.activation_state
         FROM admin.telemetry_capacity_activation_events event
         WHERE event.entitlement_id = entitlement.entitlement_id
         ORDER BY event.created_at DESC, event.id DESC
         LIMIT 1
       ) activation ON true
       WHERE entitlement.tenant_id = $1
         AND activation.activation_state = 'ACTIVE'
       ORDER BY entitlement.entitlement_version DESC
       LIMIT 1`,
      [request.tenantId],
    );
    const current = activeRows.at(0);
    const currentIngress =
      current === undefined ? 0 : this.toFiniteNumber(current.sustainedIngressMessagesPerSecond);
    const currentRows =
      current === undefined ? 0 : this.toFiniteNumber(current.sustainedMetricRowsPerMinute);
    const reservedIngressDelta = Math.max(
      0,
      request.sustainedIngressMessagesPerSecond - currentIngress,
    );
    const reservedRowsDelta = Math.max(0, request.sustainedMetricRowsPerMinute - currentRows);

    const totalsRows = await manager.query<CapacityTotalsRow[]>(
      `WITH latest_activation AS (
         SELECT DISTINCT ON (event.entitlement_id)
           event.entitlement_id,
           event.activation_state
         FROM admin.telemetry_capacity_activation_events event
         ORDER BY event.entitlement_id, event.created_at DESC, event.id DESC
       )
       SELECT /* capacity_commitment_totals */
         COALESCE(SUM(CASE
           WHEN activation.activation_state = 'ACTIVE'
             THEN entitlement.sustained_ingress_messages_per_second
           WHEN activation.activation_state = 'RESERVED'
             THEN entitlement.reserved_ingress_delta
           ELSE 0
         END), 0) AS ingress,
         COALESCE(SUM(CASE
           WHEN activation.activation_state = 'ACTIVE'
             THEN entitlement.sustained_metric_rows_per_minute
           WHEN activation.activation_state = 'RESERVED'
             THEN entitlement.reserved_metric_rows_delta
           ELSE 0
         END), 0) AS rows
       FROM admin.telemetry_capacity_entitlements entitlement
       JOIN latest_activation activation
         ON activation.entitlement_id = entitlement.entitlement_id`,
    );
    const totals = totalsRows.at(0);
    if (totals === undefined) {
      throw new Error('Telemetry capacity commitment totals were not returned');
    }
    const activationState: TelemetryCapacityActivationState =
      this.toFiniteNumber(totals.ingress) + reservedIngressDelta <=
        this.toFiniteNumber(envelope.ingressLimit) &&
      this.toFiniteNumber(totals.rows) + reservedRowsDelta <= this.toFiniteNumber(envelope.rowLimit)
        ? 'RESERVED'
        : 'PENDING_CAPACITY';

    const versionRows = await manager.query<VersionRow[]>(
      `SELECT /* next_entitlement_version */
         COALESCE(MAX(entitlement_version), 0) + 1 AS version
       FROM admin.telemetry_capacity_entitlements
       WHERE tenant_id = $1`,
      [request.tenantId],
    );
    const versionRow = versionRows.at(0);
    if (versionRow === undefined) {
      throw new Error('Next telemetry entitlement version was not returned');
    }

    const proposedEntitlementId = randomUUID();
    const proposedReservationId = randomUUID();
    const entitlementVersion = this.toFiniteNumber(versionRow.version);
    const insertedRows = await manager.query<InsertedEntitlementRow[]>(
      `INSERT INTO admin.telemetry_capacity_entitlements (
         entitlement_id,
         reservation_id,
         operation_id,
         tenant_id,
         entitlement_version,
         capacity_envelope_id,
         capacity_envelope_version,
         sustained_ingress_messages_per_second,
         sustained_metric_rows_per_minute,
         reserved_ingress_delta,
         reserved_metric_rows_delta,
         effective_at,
         retention_approval_state,
         archive_tier
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'UNAPPROVED', NULL)
       RETURNING entitlement_id AS "entitlementId", reservation_id AS "reservationId"`,
      [
        proposedEntitlementId,
        proposedReservationId,
        request.operationId,
        request.tenantId,
        entitlementVersion,
        envelope.id,
        this.toFiniteNumber(envelope.version),
        request.sustainedIngressMessagesPerSecond,
        request.sustainedMetricRowsPerMinute,
        reservedIngressDelta,
        reservedRowsDelta,
        request.effectiveAt,
      ],
    );
    const inserted = insertedRows.at(0);
    if (inserted === undefined) {
      throw new Error('Telemetry capacity entitlement insert returned no row');
    }
    await manager.query(
      `INSERT INTO admin.telemetry_capacity_activation_events (
         id, entitlement_id, activation_state, effective_at, capacity_envelope_version
       ) VALUES ($1, $2, $3, $4, $5)`,
      [
        randomUUID(),
        inserted.entitlementId,
        activationState,
        request.effectiveAt,
        this.toFiniteNumber(envelope.version),
      ],
    );

    const snapshot: TelemetryCapacityEntitlementSnapshot = {
      operationId: request.operationId,
      tenantId: request.tenantId,
      reservationId: inserted.reservationId,
      entitlementId: inserted.entitlementId,
      entitlementVersion,
      activationState,
      effectiveAt: request.effectiveAt,
      capacityEnvelopeVersion: this.toFiniteNumber(envelope.version),
      sustainedIngressMessagesPerSecond: request.sustainedIngressMessagesPerSecond,
      sustainedMetricRowsPerMinute: request.sustainedMetricRowsPerMinute,
    };
    await this.enqueueSnapshotEvent(snapshot, manager, `telemetry-capacity:${request.operationId}`);
    return snapshot;
  }

  async release(
    operationId: string,
    tenantId: string,
  ): Promise<TelemetryCapacityEntitlementSnapshot> {
    return this.dataSource.transaction('SERIALIZABLE', async (manager) => {
      const envelopeRows = await manager.query<EnvelopeRow[]>(
        `SELECT /* capacity_envelope_for_release */
           id,
           version,
           sustained_ingress_messages_per_second AS "ingressLimit",
           sustained_metric_rows_per_minute AS "rowLimit"
         FROM admin.telemetry_capacity_envelopes
         WHERE state = 'ACTIVE'
           AND effective_at <= now()
         ORDER BY version DESC
         LIMIT 1
         FOR UPDATE`,
      );
      const envelopeRow = envelopeRows.at(0);
      if (envelopeRow === undefined) {
        throw new Error('No active telemetry capacity envelope is effective');
      }

      const rows = await manager.query<EntitlementRow[]>(
        `SELECT /* capacity_entitlement_for_release */
           entitlement.operation_id AS "operationId",
           entitlement.tenant_id AS "tenantId",
           entitlement.reservation_id AS "reservationId",
           entitlement.entitlement_id AS "entitlementId",
           entitlement.entitlement_version AS "entitlementVersion",
           activation.activation_state AS "activationState",
           entitlement.effective_at AS "effectiveAt",
           entitlement.capacity_envelope_version AS "capacityEnvelopeVersion",
           entitlement.sustained_ingress_messages_per_second AS "sustainedIngressMessagesPerSecond",
           entitlement.sustained_metric_rows_per_minute AS "sustainedMetricRowsPerMinute"
         FROM admin.telemetry_capacity_entitlements entitlement
         JOIN LATERAL (
           SELECT event.activation_state
           FROM admin.telemetry_capacity_activation_events event
           WHERE event.entitlement_id = entitlement.entitlement_id
           ORDER BY event.created_at DESC, event.id DESC
           LIMIT 1
         ) activation ON true
         WHERE entitlement.operation_id = $1
           AND entitlement.tenant_id = $2
         LIMIT 1
         FOR UPDATE OF entitlement`,
        [operationId, tenantId],
      );
      const row = rows.at(0);
      if (row === undefined) {
        throw new Error(`Telemetry capacity entitlement not found for operation ${operationId}`);
      }
      const snapshot = this.toSnapshot(row);
      if (snapshot.activationState === 'RELEASED') return snapshot;
      if (
        snapshot.activationState !== 'ACTIVE' &&
        snapshot.activationState !== 'RESERVED' &&
        snapshot.activationState !== 'PENDING_CAPACITY'
      ) {
        throw new Error(
          `Telemetry capacity entitlement ${snapshot.entitlementId} cannot release from ${snapshot.activationState}`,
        );
      }

      let previous: TelemetryCapacityEntitlementSnapshot | undefined;
      if (snapshot.activationState === 'ACTIVE') {
        const previousRows = await manager.query<EntitlementRow[]>(
          `SELECT /* previous_capacity_entitlement_for_restore */
             entitlement.operation_id AS "operationId",
             entitlement.tenant_id AS "tenantId",
             entitlement.reservation_id AS "reservationId",
             entitlement.entitlement_id AS "entitlementId",
             entitlement.entitlement_version AS "entitlementVersion",
             activation.activation_state AS "activationState",
             entitlement.effective_at AS "effectiveAt",
             entitlement.capacity_envelope_version AS "capacityEnvelopeVersion",
             entitlement.sustained_ingress_messages_per_second AS "sustainedIngressMessagesPerSecond",
             entitlement.sustained_metric_rows_per_minute AS "sustainedMetricRowsPerMinute"
           FROM admin.telemetry_capacity_entitlements entitlement
           JOIN LATERAL (
             SELECT event.activation_state
             FROM admin.telemetry_capacity_activation_events event
             WHERE event.entitlement_id = entitlement.entitlement_id
             ORDER BY event.created_at DESC, event.id DESC
             LIMIT 1
           ) activation ON true
           WHERE entitlement.tenant_id = $1
             AND entitlement.entitlement_version < $2
             AND activation.activation_state = 'SUPERSEDED'
           ORDER BY entitlement.entitlement_version DESC
           LIMIT 1
           FOR UPDATE OF entitlement`,
          [tenantId, snapshot.entitlementVersion],
        );
        const previousRow = previousRows.at(0);
        if (previousRow === undefined) {
          throw new Error('The first active telemetry capacity entitlement cannot be released');
        }
        previous = this.toSnapshot(previousRow);
      }

      const candidateIngress = previous?.sustainedIngressMessagesPerSecond ?? 0;
      const candidateRows = previous?.sustainedMetricRowsPerMinute ?? 0;
      const totalsRows = await manager.query<CapacityTotalsRow[]>(
        `WITH latest_activation AS (
           SELECT DISTINCT ON (event.entitlement_id)
             event.entitlement_id,
             event.activation_state
           FROM admin.telemetry_capacity_activation_events event
           ORDER BY event.entitlement_id, event.created_at DESC, event.id DESC
         )
         SELECT /* capacity_commitments_after_release */
           COALESCE(SUM(CASE
             WHEN entitlement.entitlement_id = $1 THEN 0
             WHEN activation.activation_state = 'ACTIVE'
               THEN entitlement.sustained_ingress_messages_per_second
             WHEN activation.activation_state = 'RESERVED'
               THEN entitlement.reserved_ingress_delta
             ELSE 0
           END), 0) + $2 AS ingress,
           COALESCE(SUM(CASE
             WHEN entitlement.entitlement_id = $1 THEN 0
             WHEN activation.activation_state = 'ACTIVE'
               THEN entitlement.sustained_metric_rows_per_minute
             WHEN activation.activation_state = 'RESERVED'
               THEN entitlement.reserved_metric_rows_delta
             ELSE 0
           END), 0) + $3 AS rows
         FROM admin.telemetry_capacity_entitlements entitlement
         JOIN latest_activation activation
           ON activation.entitlement_id = entitlement.entitlement_id`,
        [snapshot.entitlementId, candidateIngress, candidateRows],
      );
      const totals = totalsRows.at(0);
      if (totals === undefined) {
        throw new Error('Telemetry capacity rollback totals were not returned');
      }
      if (
        this.toFiniteNumber(totals.ingress) > this.toFiniteNumber(envelopeRow.ingressLimit) ||
        this.toFiniteNumber(totals.rows) > this.toFiniteNumber(envelopeRow.rowLimit)
      ) {
        throw new Error('Restoring the previous entitlement exceeds the active capacity envelope');
      }

      const releasedAt = new Date();
      await manager.query(
        `INSERT INTO admin.telemetry_capacity_activation_events (
           id, entitlement_id, activation_state, effective_at, capacity_envelope_version
         ) VALUES /* append_released_capacity_entitlement */ ($1, $2, 'RELEASED', $3, $4)`,
        [
          randomUUID(),
          snapshot.entitlementId,
          releasedAt,
          this.toFiniteNumber(envelopeRow.version),
        ],
      );
      const releasedSnapshot: TelemetryCapacityEntitlementSnapshot = {
        ...snapshot,
        activationState: 'RELEASED',
      };
      await this.enqueueSnapshotEvent(
        releasedSnapshot,
        manager,
        `telemetry-capacity:${operationId}:RELEASED`,
      );

      if (previous !== undefined) {
        await manager.query(
          `INSERT INTO admin.telemetry_capacity_activation_events (
             id, entitlement_id, activation_state, effective_at, capacity_envelope_version
           ) VALUES /* restore_previous_active_capacity_entitlement */ ($1, $2, 'ACTIVE', $3, $4)`,
          [
            randomUUID(),
            previous.entitlementId,
            releasedAt,
            this.toFiniteNumber(envelopeRow.version),
          ],
        );
        const restoredSnapshot: TelemetryCapacityEntitlementSnapshot = {
          ...previous,
          activationState: 'ACTIVE',
        };
        await this.enqueueSnapshotEvent(
          restoredSnapshot,
          manager,
          `telemetry-capacity:${previous.operationId}:RESTORED`,
        );
      }

      await manager.query(
        `/* cancel_released_capacity_provisioning_run */
         UPDATE admin.tenant_provisioning_runs
         SET state = 'FAILED',
             "lastError" = 'Telemetry capacity reservation released by platform admin',
             "nextRetryAt" = NULL,
             "updatedAt" = now()
         WHERE id = $1
           AND state IN ('RESERVING', 'QUEUED')`,
        [operationId],
      );

      const envelope: TelemetryCapacityEnvelopeSnapshot = {
        id: envelopeRow.id,
        version: this.toFiniteNumber(envelopeRow.version),
        sustainedIngressMessagesPerSecond: this.toFiniteNumber(envelopeRow.ingressLimit),
        sustainedMetricRowsPerMinute: this.toFiniteNumber(envelopeRow.rowLimit),
        effectiveAt: releasedAt,
      };
      await this.promotePendingEntitlements(envelope, manager);
      return releasedSnapshot;
    });
  }

  async activate(
    operationId: string,
    tenantId: string,
  ): Promise<TelemetryCapacityEntitlementSnapshot> {
    return this.dataSource.transaction('SERIALIZABLE', async (manager) => {
      const rows = await manager.query<EntitlementRow[]>(
        `SELECT /* capacity_entitlement_for_activation */
           entitlement.operation_id AS "operationId",
           entitlement.tenant_id AS "tenantId",
           entitlement.reservation_id AS "reservationId",
           entitlement.entitlement_id AS "entitlementId",
           entitlement.entitlement_version AS "entitlementVersion",
           activation.activation_state AS "activationState",
           entitlement.effective_at AS "effectiveAt",
           entitlement.capacity_envelope_version AS "capacityEnvelopeVersion",
           entitlement.sustained_ingress_messages_per_second AS "sustainedIngressMessagesPerSecond",
           entitlement.sustained_metric_rows_per_minute AS "sustainedMetricRowsPerMinute"
         FROM admin.telemetry_capacity_entitlements entitlement
         JOIN LATERAL (
           SELECT event.activation_state, event.capacity_envelope_version
           FROM admin.telemetry_capacity_activation_events event
           WHERE event.entitlement_id = entitlement.entitlement_id
           ORDER BY event.created_at DESC, event.id DESC
           LIMIT 1
         ) activation ON true
         WHERE entitlement.operation_id = $1
           AND entitlement.tenant_id = $2
         LIMIT 1
         FOR UPDATE OF entitlement`,
        [operationId, tenantId],
      );
      const row = rows.at(0);
      if (row === undefined) {
        throw new Error(`Telemetry capacity entitlement not found for operation ${operationId}`);
      }
      const snapshot = this.toSnapshot(row);
      if (snapshot.activationState === 'ACTIVE') return snapshot;
      if (snapshot.activationState !== 'RESERVED') {
        throw new Error(
          `Telemetry capacity entitlement ${snapshot.entitlementId} cannot activate from ${snapshot.activationState}`,
        );
      }

      const schemaName = getTenantSchemaName(tenantId);
      const prerequisiteRows = await manager.query<ActivationPrerequisiteRow[]>(
        `SELECT /* telemetry_activation_prerequisites */
           EXISTS (
             SELECT 1
             FROM timescaledb_information.hypertables
             WHERE hypertable_schema = $1
               AND hypertable_name = 'sensor_metrics'
           ) AS "hypertableReady",
           (
             SELECT count(*)::int
             FROM timescaledb_information.continuous_aggregates
             WHERE view_schema = $1
               AND view_name IN ('metrics_1min', 'metrics_1hour', 'metrics_1day')
           ) AS "caggCount"`,
        [schemaName],
      );
      const prerequisites = prerequisiteRows.at(0);
      if (
        prerequisites === undefined ||
        prerequisites.hypertableReady !== true ||
        this.toFiniteNumber(prerequisites.caggCount) !== 3
      ) {
        throw new Error(
          `Telemetry capacity activation prerequisites are incomplete for tenant ${tenantId}`,
        );
      }

      const activationAt = new Date();
      await manager.query(
        `INSERT INTO admin.telemetry_capacity_activation_events (
           id, entitlement_id, activation_state, effective_at, capacity_envelope_version
         )
         SELECT /* supersede_previous_active_entitlement */
           uuid_generate_v4(), entitlement.entitlement_id, 'SUPERSEDED', $3,
           activation.capacity_envelope_version
         FROM admin.telemetry_capacity_entitlements entitlement
         JOIN LATERAL (
           SELECT event.activation_state, event.capacity_envelope_version
           FROM admin.telemetry_capacity_activation_events event
           WHERE event.entitlement_id = entitlement.entitlement_id
           ORDER BY event.created_at DESC, event.id DESC
           LIMIT 1
         ) activation ON true
         WHERE entitlement.tenant_id = $1
           AND entitlement.entitlement_id <> $2
           AND activation.activation_state = 'ACTIVE'`,
        [tenantId, snapshot.entitlementId, activationAt],
      );
      await manager.query(
        `INSERT INTO admin.telemetry_capacity_activation_events (
           id, entitlement_id, activation_state, effective_at, capacity_envelope_version
         ) VALUES ($1, $2, 'ACTIVE', $3, $4)`,
        [randomUUID(), snapshot.entitlementId, activationAt, snapshot.capacityEnvelopeVersion],
      );
      const activeSnapshot: TelemetryCapacityEntitlementSnapshot = {
        ...snapshot,
        activationState: 'ACTIVE',
      };
      await this.enqueueSnapshotEvent(
        activeSnapshot,
        manager,
        `telemetry-capacity:${operationId}:ACTIVE`,
      );
      return activeSnapshot;
    });
  }

  private async enqueueSnapshotEvent(
    snapshot: TelemetryCapacityEntitlementSnapshot,
    manager: EntityManager,
    idempotencyKey: string,
  ): Promise<void> {
    const event: TelemetryCapacityEntitlementChangedEvent = {
      ...createBaseEvent<TelemetryCapacityEntitlementChangedEvent>(
        'TelemetryCapacityEntitlementChanged',
        snapshot.tenantId,
        {
          aggregateId: snapshot.entitlementId,
          aggregateType: 'TelemetryCapacityEntitlement',
          correlationId: snapshot.operationId,
        },
      ),
      operationId: snapshot.operationId,
      reservationId: snapshot.reservationId,
      entitlementId: snapshot.entitlementId,
      entitlementVersion: snapshot.entitlementVersion,
      activationState: snapshot.activationState,
      effectiveAt: snapshot.effectiveAt.toISOString(),
      capacityEnvelopeVersion: snapshot.capacityEnvelopeVersion,
      sustainedIngressMessagesPerSecond: snapshot.sustainedIngressMessagesPerSecond,
      sustainedMetricRowsPerMinute: snapshot.sustainedMetricRowsPerMinute,
    };
    await this.outboxPublisher.enqueue(event, manager, {
      idempotencyKey,
      aggregateId: snapshot.entitlementId,
    });
  }

  private async promotePendingEntitlements(
    envelope: TelemetryCapacityEnvelopeSnapshot,
    manager: EntityManager,
  ): Promise<void> {
    const promotedRows = await manager.query<EntitlementRow[]>(
      `WITH latest_activation AS (
         SELECT DISTINCT ON (event.entitlement_id)
           event.entitlement_id,
           event.activation_state
         FROM admin.telemetry_capacity_activation_events event
         ORDER BY event.entitlement_id, event.created_at DESC, event.id DESC
       ), committed AS (
         SELECT
           COALESCE(SUM(CASE
             WHEN activation.activation_state = 'ACTIVE'
               THEN entitlement.sustained_ingress_messages_per_second
             WHEN activation.activation_state = 'RESERVED'
               THEN entitlement.reserved_ingress_delta
             ELSE 0
           END), 0) AS ingress,
           COALESCE(SUM(CASE
             WHEN activation.activation_state = 'ACTIVE'
               THEN entitlement.sustained_metric_rows_per_minute
             WHEN activation.activation_state = 'RESERVED'
               THEN entitlement.reserved_metric_rows_delta
             ELSE 0
           END), 0) AS rows
         FROM admin.telemetry_capacity_entitlements entitlement
         JOIN latest_activation activation
           ON activation.entitlement_id = entitlement.entitlement_id
       ), pending_locked AS (
         SELECT entitlement.*
         FROM admin.telemetry_capacity_entitlements entitlement
         JOIN latest_activation activation
           ON activation.entitlement_id = entitlement.entitlement_id
         WHERE activation.activation_state = 'PENDING_CAPACITY'
         ORDER BY entitlement.created_at, entitlement.entitlement_id
         FOR UPDATE OF entitlement
       ), pending AS (
         SELECT
           pending_locked.*,
           SUM(pending_locked.reserved_ingress_delta) OVER (
             ORDER BY pending_locked.created_at, pending_locked.entitlement_id
           ) AS cumulative_ingress,
           SUM(pending_locked.reserved_metric_rows_delta) OVER (
             ORDER BY pending_locked.created_at, pending_locked.entitlement_id
           ) AS cumulative_rows
         FROM pending_locked
       ), promoted AS (
         INSERT INTO admin.telemetry_capacity_activation_events (
           id,
           entitlement_id,
           activation_state,
           effective_at,
           capacity_envelope_version
         )
         SELECT /* promote_pending_capacity_entitlements */
           uuid_generate_v4(),
           pending.entitlement_id,
           'RESERVED',
           $3,
           $4
         FROM pending
         CROSS JOIN committed
         WHERE committed.ingress + pending.cumulative_ingress <= $1
           AND committed.rows + pending.cumulative_rows <= $2
         RETURNING entitlement_id, effective_at, capacity_envelope_version
       )
       SELECT
         entitlement.operation_id AS "operationId",
         entitlement.tenant_id AS "tenantId",
         entitlement.reservation_id AS "reservationId",
         entitlement.entitlement_id AS "entitlementId",
         entitlement.entitlement_version AS "entitlementVersion",
         'RESERVED' AS "activationState",
         promoted.effective_at AS "effectiveAt",
         promoted.capacity_envelope_version AS "capacityEnvelopeVersion",
         entitlement.sustained_ingress_messages_per_second AS "sustainedIngressMessagesPerSecond",
         entitlement.sustained_metric_rows_per_minute AS "sustainedMetricRowsPerMinute"
       FROM promoted
       JOIN admin.telemetry_capacity_entitlements entitlement
         ON entitlement.entitlement_id = promoted.entitlement_id`,
      [
        envelope.sustainedIngressMessagesPerSecond,
        envelope.sustainedMetricRowsPerMinute,
        envelope.effectiveAt,
        envelope.version,
      ],
    );
    const operationIds = promotedRows.map((row) => row.operationId);
    await manager.query(
      `/* release_capacity_blocked_provisioning_runs */
       UPDATE admin.tenant_provisioning_runs
       SET state = 'QUEUED',
           "nextRetryAt" = now(),
           "lastError" = NULL,
           "updatedAt" = now()
       WHERE id = ANY($1::uuid[])
         AND state = 'RESERVING'`,
      [operationIds],
    );
    for (const promoted of promotedRows) {
      const snapshot = this.toSnapshot(promoted);
      await this.enqueueSnapshotEvent(
        snapshot,
        manager,
        `telemetry-capacity:${snapshot.operationId}:RESERVED`,
      );
    }
  }

  private toSnapshot(row: EntitlementRow): TelemetryCapacityEntitlementSnapshot {
    return {
      operationId: row.operationId,
      tenantId: row.tenantId,
      reservationId: row.reservationId,
      entitlementId: row.entitlementId,
      entitlementVersion: this.toFiniteNumber(row.entitlementVersion),
      activationState: row.activationState,
      effectiveAt: row.effectiveAt instanceof Date ? row.effectiveAt : new Date(row.effectiveAt),
      capacityEnvelopeVersion: this.toFiniteNumber(row.capacityEnvelopeVersion),
      sustainedIngressMessagesPerSecond: this.toFiniteNumber(row.sustainedIngressMessagesPerSecond),
      sustainedMetricRowsPerMinute: this.toFiniteNumber(row.sustainedMetricRowsPerMinute),
    };
  }

  private toFiniteNumber(value: number | string | null): number {
    const numeric = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(numeric)) {
      throw new Error('Telemetry capacity persistence returned a non-finite number');
    }
    return numeric;
  }

  private assertValidRequest(request: ReserveTelemetryCapacityRequest): void {
    this.assertPositiveCapacity(
      request.sustainedIngressMessagesPerSecond,
      request.sustainedMetricRowsPerMinute,
      request.effectiveAt,
    );
  }

  private assertPositiveCapacity(
    sustainedIngressMessagesPerSecond: number,
    sustainedMetricRowsPerMinute: number,
    effectiveAt: Date,
  ): void {
    if (
      !Number.isFinite(sustainedIngressMessagesPerSecond) ||
      sustainedIngressMessagesPerSecond <= 0 ||
      !Number.isFinite(sustainedMetricRowsPerMinute) ||
      sustainedMetricRowsPerMinute <= 0 ||
      Number.isNaN(effectiveAt.getTime())
    ) {
      throw new Error('Telemetry capacity request must contain positive finite M/R values');
    }
  }
}
