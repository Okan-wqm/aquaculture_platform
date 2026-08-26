import type { DataSource } from 'typeorm';

import { PostgresTelemetryArchiveErasureService } from '../postgres-telemetry-archive-erasure.service';

describe('PostgresTelemetryArchiveErasureService', () => {
  it('uses the dedicated capability role inside a serializable transaction', async () => {
    const query = jest.fn(async (statement: string) =>
      statement.includes('erase_telemetry_archive_tenant_links')
        ? [{ deletedEventCount: '4', evidenceSha256: 'a'.repeat(64) }]
        : [],
    );
    const runner = {
      connect: jest.fn(async () => undefined),
      startTransaction: jest.fn(async () => undefined),
      query,
      commitTransaction: jest.fn(async () => undefined),
      rollbackTransaction: jest.fn(async () => undefined),
      release: jest.fn(async () => undefined),
    };
    const source: Partial<DataSource> = { createQueryRunner: () => runner as never };
    const service = new PostgresTelemetryArchiveErasureService(source as DataSource);

    await expect(
      service.eraseTenantLinks(
        '22222222-2222-4222-8222-222222222222',
        '11111111-1111-4111-8111-111111111111',
      ),
    ).resolves.toEqual({ deletedEventCount: 4, evidenceSha256: 'a'.repeat(64) });
    expect(runner.startTransaction).toHaveBeenCalledWith('SERIALIZABLE');
    expect(query).toHaveBeenCalledWith('SET LOCAL ROLE telemetry_archive_erasure');
    expect(runner.commitTransaction).toHaveBeenCalled();
  });
});
