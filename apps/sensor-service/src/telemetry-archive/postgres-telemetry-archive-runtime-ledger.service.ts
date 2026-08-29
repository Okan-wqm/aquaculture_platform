import { isValidUUID, queryRowsNormalized } from '@aquaculture/backend-common/database';
import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import type { TelemetryArchivePresignLedgerPort } from './telemetry-archive-presign.service';
import type { TelemetryTenantCancellationPort } from './telemetry-archive-coordinator.service';

@Injectable()
export class PostgresTelemetryArchiveRuntimeLedgerService
  implements TelemetryArchivePresignLedgerPort, TelemetryTenantCancellationPort
{
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async assertTenantActive(tenantId: string): Promise<void> {
    this.assertUuid(tenantId, 'tenantId');
    await this.dataSource.query('SELECT sensor.assert_telemetry_archive_tenant_active($1::uuid)', [
      tenantId,
    ]);
  }

  async cancelTenant(tenantId: string, erasureOperationId: string): Promise<void> {
    this.assertUuid(tenantId, 'tenantId');
    this.assertUuid(erasureOperationId, 'erasureOperationId');
    await this.dataSource.query(
      'SELECT sensor.cancel_telemetry_archive_tenant($1::uuid, $2::uuid)',
      [tenantId, erasureOperationId],
    );
  }

  async record(entry: {
    readonly tenantId: string;
    readonly operationId: string;
    readonly urlSha256: string;
    readonly expiresAt: string;
  }): Promise<void> {
    this.assertUuid(entry.tenantId, 'tenantId');
    this.assertUuid(entry.operationId, 'operationId');
    if (!/^[0-9a-f]{64}$/.test(entry.urlSha256)) {
      throw new Error('Telemetry archive presign URL SHA-256 is invalid');
    }
    const expiresAt = new Date(entry.expiresAt);
    if (!Number.isFinite(expiresAt.getTime())) {
      throw new Error('Telemetry archive presign expiry is invalid');
    }
    await this.dataSource.query(
      `SELECT sensor.record_telemetry_archive_presign(
         $1::uuid, $2::uuid, $3::text, $4::timestamptz
       )`,
      [entry.tenantId, entry.operationId, entry.urlSha256, expiresAt.toISOString()],
    );
  }

  async revokeTenant(tenantId: string): Promise<void> {
    this.assertUuid(tenantId, 'tenantId');
    const rows = queryRowsNormalized<{ revokedCount: string }>(
      await this.dataSource.query(
        `SELECT sensor.revoke_telemetry_archive_presigns($1::uuid)::text
           AS "revokedCount"`,
        [tenantId],
      ),
    );
    const revokedCount = Number(rows[0]?.revokedCount);
    if (!Number.isSafeInteger(revokedCount) || revokedCount < 0) {
      throw new Error('Telemetry archive presign revocation returned an invalid count');
    }
  }

  private assertUuid(value: string, field: string): void {
    if (!isValidUUID(value)) throw new Error(`Telemetry archive ${field} must be a UUID`);
  }
}
