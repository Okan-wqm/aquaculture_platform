import type { DataSource } from 'typeorm';

import { PostgresTelemetryArchiveRuntimeLedgerService } from '../postgres-telemetry-archive-runtime-ledger.service';

const TENANT_ID = '22222222-2222-4222-8222-222222222222';
const OPERATION_ID = '11111111-1111-4111-8111-111111111111';

describe('PostgresTelemetryArchiveRuntimeLedgerService', () => {
  it('uses database capability functions for durable cancellation and presign evidence', async () => {
    const query = jest.fn(async (sql: string) =>
      sql.includes('revoke_telemetry_archive_presigns') ? [{ revokedCount: '1' }] : [],
    );
    const dataSource: Partial<DataSource> = { query: query as DataSource['query'] };
    const service = new PostgresTelemetryArchiveRuntimeLedgerService(dataSource as DataSource);

    await service.assertTenantActive(TENANT_ID);
    await service.cancelTenant(TENANT_ID, OPERATION_ID);
    await service.record({
      tenantId: TENANT_ID,
      operationId: OPERATION_ID,
      urlSha256: 'a'.repeat(64),
      expiresAt: '2026-01-01T00:15:00.000Z',
    });
    await service.revokeTenant(TENANT_ID);

    const sql = query.mock.calls.map(([statement]) => statement).join('\n');
    expect(sql).toContain('assert_telemetry_archive_tenant_active');
    expect(sql).toContain('cancel_telemetry_archive_tenant');
    expect(sql).toContain('record_telemetry_archive_presign');
    expect(sql).toContain('revoke_telemetry_archive_presigns');
    expect(sql).not.toContain('INSERT INTO sensor.telemetry_archive_presigns');
  });

  it('rejects invalid identities before reaching PostgreSQL', async () => {
    const query = jest.fn();
    const dataSource: Partial<DataSource> = { query: query as DataSource['query'] };
    const service = new PostgresTelemetryArchiveRuntimeLedgerService(dataSource as DataSource);

    await expect(service.cancelTenant('invalid', OPERATION_ID)).rejects.toThrow(/UUID/i);
    expect(query).not.toHaveBeenCalled();
  });
});
