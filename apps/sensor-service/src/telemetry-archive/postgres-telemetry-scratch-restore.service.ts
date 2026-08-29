import { isValidUUID, queryRowsNormalized } from '@aquaculture/backend-common/database';
import type { DataSource, QueryRunner } from 'typeorm';

import type {
  TelemetryArchiveClock,
  TelemetryRawRow,
  TelemetryScratchRestorePort,
  TelemetryScratchRestoreResult,
} from './telemetry-archive-coordinator.service';

const RESTORE_ROLE = 'telemetry_archive_restore';
const MAX_TTL_SECONDS = 86_400;
const INSERT_BATCH_SIZE = 250;

interface RestorePrivilegeRow {
  readonly roleName: string;
  readonly isRestoreRoleMember: boolean;
  readonly canCreateDatabase: boolean;
  readonly canWriteTenantSchema: boolean;
  readonly canMutateArchiveLedger: boolean;
}

interface RestoreAnalyticsRow {
  readonly rowCount: string;
  readonly p50: number | null;
  readonly minValue: number | null;
  readonly maxValue: number | null;
}

export class PostgresTelemetryScratchRestoreService implements TelemetryScratchRestorePort {
  constructor(
    private readonly dataSource: DataSource,
    private readonly clock: TelemetryArchiveClock,
  ) {}

  async restore(
    request: {
      readonly tenantId: string;
      readonly operationId: string;
      readonly expectedSha256: string;
      readonly ttlSeconds: number;
    },
    rows: AsyncIterable<TelemetryRawRow>,
  ): Promise<TelemetryScratchRestoreResult> {
    this.assertRequest(request);
    const schemaName = `restore_${request.operationId.replaceAll('-', '')}`;
    const expiresAt = new Date(this.clock.now().getTime() + request.ttlSeconds * 1_000);
    const runner = this.dataSource.createQueryRunner();
    await runner.connect();
    try {
      await runner.startTransaction('SERIALIZABLE');
      await runner.query(`SET LOCAL ROLE ${RESTORE_ROLE}`);
      await this.assertRestoreIdentity(runner);
      const createdRows = queryRowsNormalized<{ schemaName: string }>(
        await runner.query(
          `SELECT sensor.create_telemetry_restore_scratch(
             $1::uuid, $2::uuid, $3::text, $4::timestamptz
           ) AS "schemaName"`,
          [request.operationId, request.tenantId, request.expectedSha256, expiresAt.toISOString()],
        ),
      );
      if (createdRows[0]?.schemaName !== schemaName) {
        throw new Error('Telemetry restore scratch function returned an unexpected schema');
      }

      let rowCount = 0;
      let batch: TelemetryRawRow[] = [];
      for await (const row of rows) {
        if (row.tenantId !== request.tenantId) {
          throw new Error('Scratch restore received a row from another tenant');
        }
        batch.push(row);
        if (batch.length === INSERT_BATCH_SIZE) {
          await this.insertBatch(runner, schemaName, batch);
          rowCount += batch.length;
          batch = [];
        }
      }
      if (batch.length > 0) {
        await this.insertBatch(runner, schemaName, batch);
        rowCount += batch.length;
      }

      const analytics = queryRowsNormalized<RestoreAnalyticsRow>(
        await runner.query(
          `SELECT count(*)::text AS "rowCount",
                  percentile_cont(0.5) WITHIN GROUP (ORDER BY value) AS p50,
                  min(value) AS "minValue",
                  max(value) AS "maxValue"
             FROM "${schemaName}".sensor_metrics`,
        ),
      )[0];
      const analyticRowCount = Number(analytics?.rowCount);
      const analyticQueriesPassed =
        Number.isSafeInteger(analyticRowCount) &&
        analyticRowCount === rowCount &&
        (rowCount === 0 ||
          (Number.isFinite(analytics?.p50) &&
            Number.isFinite(analytics?.minValue) &&
            Number.isFinite(analytics?.maxValue)));
      if (!analyticQueriesPassed) {
        throw new Error('Scratch restore analytic count/percentile/waveform parity failed');
      }
      await runner.commitTransaction();
      return {
        schemaName,
        expiresAt: expiresAt.toISOString(),
        rowCount,
        sha256: request.expectedSha256,
        analyticQueriesPassed,
      };
    } catch (error: unknown) {
      await runner.rollbackTransaction();
      throw error;
    } finally {
      await runner.release();
    }
  }

  async cleanupExpired(): Promise<number> {
    const runner = this.dataSource.createQueryRunner();
    await runner.connect();
    try {
      await runner.startTransaction('SERIALIZABLE');
      await runner.query(`SET LOCAL ROLE ${RESTORE_ROLE}`);
      const rows = queryRowsNormalized<{ droppedCount: string }>(
        await runner.query(
          `SELECT sensor.drop_expired_telemetry_restore_scratch()::text AS "droppedCount"`,
        ),
      );
      const droppedCount = Number(rows[0]?.droppedCount);
      if (!Number.isSafeInteger(droppedCount) || droppedCount < 0) {
        throw new Error('Telemetry restore cleanup returned an invalid dropped count');
      }
      await runner.commitTransaction();
      return droppedCount;
    } catch (error: unknown) {
      await runner.rollbackTransaction();
      throw error;
    } finally {
      await runner.release();
    }
  }

  private async assertRestoreIdentity(runner: QueryRunner): Promise<void> {
    const privileges = queryRowsNormalized<RestorePrivilegeRow>(
      await runner.query(
        `SELECT current_user AS "roleName",
                pg_has_role(current_user, '${RESTORE_ROLE}', 'MEMBER')
                  AS "isRestoreRoleMember",
                has_database_privilege(current_user, current_database(), 'CREATE')
                  AS "canCreateDatabase",
                EXISTS (
                  SELECT 1
                    FROM pg_namespace
                   WHERE nspname LIKE 'tenant\\_%' ESCAPE '\\'
                     AND has_schema_privilege(current_user, nspname, 'CREATE')
                ) AS "canWriteTenantSchema",
                has_table_privilege(
                  current_user,
                  'sensor.telemetry_archive_events',
                  'INSERT,UPDATE,DELETE'
                ) AS "canMutateArchiveLedger"`,
      ),
    )[0];
    if (
      privileges === undefined ||
      !privileges.isRestoreRoleMember ||
      privileges.canCreateDatabase ||
      privileges.canWriteTenantSchema ||
      privileges.canMutateArchiveLedger
    ) {
      throw new Error('Telemetry restore identity has production mutation privileges');
    }
  }

  private async insertBatch(
    runner: QueryRunner,
    schemaName: string,
    rows: readonly TelemetryRawRow[],
  ): Promise<void> {
    const columnsPerRow = 21;
    const parameters: unknown[] = [];
    const values = rows.map((row, rowIndex) => {
      parameters.push(
        row.time,
        row.sensorId,
        row.channelId,
        row.tenantId,
        row.rawValue,
        row.value,
        row.qualityCode,
        row.qualityBits,
        row.sourceEventId,
        row.sourceTimestamp,
        row.sourceSequence,
        row.siteId ?? null,
        row.departmentId ?? null,
        row.systemId ?? null,
        row.equipmentId ?? null,
        row.tankId ?? null,
        row.pondId ?? null,
        row.farmId ?? null,
        row.sourceProtocol ?? null,
        row.ingestionLatencyMs ?? null,
        row.batchId ?? null,
      );
      const offset = rowIndex * columnsPerRow;
      return `(${Array.from({ length: columnsPerRow }, (_value, index) => `$${offset + index + 1}`).join(', ')})`;
    });
    await runner.query(
      `INSERT INTO "${schemaName}".sensor_metrics (
         time, sensor_id, channel_id, tenant_id, raw_value, value,
         quality_code, quality_bits, source_event_id, source_timestamp,
         source_sequence, site_id, department_id, system_id, equipment_id,
         tank_id, pond_id, farm_id, source_protocol, ingestion_latency_ms, batch_id
       ) VALUES ${values.join(', ')}`,
      parameters,
    );
  }

  private assertRequest(request: {
    readonly tenantId: string;
    readonly operationId: string;
    readonly expectedSha256: string;
    readonly ttlSeconds: number;
  }): void {
    if (!isValidUUID(request.tenantId) || !isValidUUID(request.operationId)) {
      throw new Error('Scratch restore tenantId and operationId must be UUIDs');
    }
    if (!/^[0-9a-f]{64}$/.test(request.expectedSha256)) {
      throw new Error('Scratch restore expectedSha256 is invalid');
    }
    if (
      !Number.isInteger(request.ttlSeconds) ||
      request.ttlSeconds < 1 ||
      request.ttlSeconds > MAX_TTL_SECONDS
    ) {
      throw new Error(`Scratch restore TTL must be between 1 and ${MAX_TTL_SECONDS} seconds`);
    }
  }
}
