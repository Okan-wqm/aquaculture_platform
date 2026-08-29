import { isValidUUID, queryRowsNormalized } from '@aquaculture/backend-common/database';
import type { DataSource } from 'typeorm';

import type { TelemetryArchiveErasureEvidence } from './telemetry-archive-coordinator.service';

const ERASURE_ROLE = 'telemetry_archive_erasure';

export class PostgresTelemetryArchiveErasureService {
  constructor(private readonly dataSource: DataSource) {}

  async eraseTenantLinks(
    tenantId: string,
    erasureOperationId: string,
  ): Promise<TelemetryArchiveErasureEvidence> {
    if (!isValidUUID(tenantId) || !isValidUUID(erasureOperationId)) {
      throw new Error('Archive erasure tenantId and operationId must be UUIDs');
    }
    const runner = this.dataSource.createQueryRunner();
    await runner.connect();
    try {
      await runner.startTransaction('SERIALIZABLE');
      await runner.query(`SET LOCAL ROLE ${ERASURE_ROLE}`);
      const rows = queryRowsNormalized<{
        deletedEventCount: string;
        evidenceSha256: string;
      }>(
        await runner.query(
          `SELECT deleted_event_count::text AS "deletedEventCount",
                  evidence_sha256 AS "evidenceSha256"
             FROM sensor.erase_telemetry_archive_tenant_links($1::uuid, $2::uuid)`,
          [tenantId, erasureOperationId],
        ),
      );
      const row = rows[0];
      const deletedEventCount = Number(row?.deletedEventCount);
      if (
        row === undefined ||
        !Number.isSafeInteger(deletedEventCount) ||
        deletedEventCount < 0 ||
        !/^[0-9a-f]{64}$/.test(row.evidenceSha256)
      ) {
        throw new Error('Archive erasure function returned invalid evidence');
      }
      await runner.commitTransaction();
      return { deletedEventCount, evidenceSha256: row.evidenceSha256 };
    } catch (error: unknown) {
      await runner.rollbackTransaction();
      throw error;
    } finally {
      await runner.release();
    }
  }
}
