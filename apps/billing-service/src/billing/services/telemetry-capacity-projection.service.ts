import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { TelemetryCapacityEntitlementChangedEvent } from '@platform/event-contracts';
import { DataSource, EntityManager } from 'typeorm';

interface ProjectionRow {
  entitlementId: string;
  operationId: string;
  reservationId: string;
  tenantId: string;
  entitlementVersion: number | string;
  effectiveAt: Date | string;
  capacityEnvelopeVersion: number | string;
  sustainedIngressMessagesPerSecond: number | string;
  sustainedMetricRowsPerMinute: number | string;
}

@Injectable()
export class TelemetryCapacityProjectionService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async project(event: TelemetryCapacityEntitlementChangedEvent): Promise<void> {
    if (event.activationState !== 'ACTIVE') return;

    await this.dataSource.transaction(async (manager) => {
      await manager.query(
        `INSERT INTO billing.telemetry_capacity_entitlements (
           entitlement_id,
           operation_id,
           reservation_id,
           tenant_id,
           entitlement_version,
           effective_at,
           capacity_envelope_version,
           sustained_ingress_messages_per_second,
           sustained_metric_rows_per_minute
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT DO NOTHING`,
        [
          event.entitlementId,
          event.operationId,
          event.reservationId,
          event.tenantId,
          event.entitlementVersion,
          event.effectiveAt,
          event.capacityEnvelopeVersion,
          event.sustainedIngressMessagesPerSecond,
          event.sustainedMetricRowsPerMinute,
        ],
      );
      const rows = await manager.query<ProjectionRow[]>(
        `SELECT
           entitlement_id AS "entitlementId",
           operation_id AS "operationId",
           reservation_id AS "reservationId",
           tenant_id AS "tenantId",
           entitlement_version AS "entitlementVersion",
           effective_at AS "effectiveAt",
           capacity_envelope_version AS "capacityEnvelopeVersion",
           sustained_ingress_messages_per_second AS "sustainedIngressMessagesPerSecond",
           sustained_metric_rows_per_minute AS "sustainedMetricRowsPerMinute"
         FROM billing.telemetry_capacity_entitlements
         WHERE entitlement_id = $1
            OR operation_id = $2
            OR (tenant_id = $3 AND entitlement_version = $4)
         FOR SHARE`,
        [event.entitlementId, event.operationId, event.tenantId, event.entitlementVersion],
      );
      const stored = rows.at(0);
      if (rows.length !== 1 || stored === undefined || !this.matches(stored, event)) {
        throw new Error(
          `immutable telemetry capacity entitlement conflict for ${event.entitlementId}`,
        );
      }
    });
  }

  private matches(row: ProjectionRow, event: TelemetryCapacityEntitlementChangedEvent): boolean {
    const effectiveAt =
      row.effectiveAt instanceof Date
        ? row.effectiveAt.toISOString()
        : new Date(row.effectiveAt).toISOString();
    return (
      row.entitlementId === event.entitlementId &&
      row.operationId === event.operationId &&
      row.reservationId === event.reservationId &&
      row.tenantId === event.tenantId &&
      Number(row.entitlementVersion) === event.entitlementVersion &&
      effectiveAt === event.effectiveAt &&
      Number(row.capacityEnvelopeVersion) === event.capacityEnvelopeVersion &&
      Number(row.sustainedIngressMessagesPerSecond) === event.sustainedIngressMessagesPerSecond &&
      Number(row.sustainedMetricRowsPerMinute) === event.sustainedMetricRowsPerMinute
    );
  }
}
