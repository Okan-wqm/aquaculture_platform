import { ServiceUnavailableException } from '@nestjs/common';
import type { Repository, SelectQueryBuilder } from 'typeorm';

import { AuditLog } from '../audit.entity';
import { AuditLogService } from '../audit.service';

describe('AuditLogService statistics scope', () => {
  const repository = {
    query: jest.fn(),
    createQueryBuilder: jest.fn(),
  } as unknown as jest.Mocked<Repository<AuditLog>>;
  let service: AuditLogService;

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-09T12:00:00.000Z'));
    jest.clearAllMocks();
    service = new AuditLogService(repository);
  });

  afterEach(() => jest.useRealTimers());

  it('computes every statistic from one SQL statement and one content-addressed scope', async () => {
    jest.mocked(repository.query).mockResolvedValueOnce([
      {
        total_logs: '3',
        observed_logs: '5',
        legacy_unverified_logs: '2',
        last_24_hours: '2',
        by_action: [
          { action: 'CREATE', count: '2' },
          { action: 'UPDATE', count: '1' },
        ],
        by_severity: [
          { severity: 'info', count: '2' },
          { severity: 'critical', count: '1' },
        ],
        by_entity_type: [{ entityType: 'Tenant', count: '3' }],
        top_users: [{ userId: 'admin-1', email: null, count: '3' }],
      },
    ]);

    const result = await service.getStatistics(
      '11111111-1111-4111-8111-111111111111',
      new Date('2026-08-01T00:00:00.000Z'),
      new Date('2026-08-10T00:00:00.000Z'),
    );

    expect(repository.query).toHaveBeenCalledTimes(1);
    const [sql, parameters] = jest.mocked(repository.query).mock.calls[0] ?? [];
    expect(sql).toContain('WITH observed AS MATERIALIZED');
    expect(sql).toContain('WHERE "trustClass" = \'AUTHORITATIVE_RUNTIME\'');
    expect(sql).toContain('FROM scoped');
    expect(parameters).toEqual([
      '11111111-1111-4111-8111-111111111111',
      new Date('2026-08-01T00:00:00.000Z'),
      new Date('2026-08-09T12:00:00.000Z'),
      new Date('2026-08-08T12:00:00.000Z'),
    ]);
    expect(result.scope).toMatchObject({
      schemaVersion: 'audit-statistics-scope.v2',
      source: 'admin.audit_logs',
      qualification: 'AUTHORITATIVE_RUNTIME_ONLY',
      startDate: '2026-08-01T00:00:00.000Z',
      endDate: '2026-08-09T12:00:00.000Z',
      asOf: '2026-08-09T12:00:00.000Z',
      scopeSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect(result.topUsers[0]?.email).toBeNull();
    expect(result).toMatchObject({
      totalLogs: 3,
      observedLogs: 5,
      legacyUnverifiedLogs: 2,
    });
  });

  it('rejects aggregate groups that do not reconcile to the scoped total', async () => {
    jest.mocked(repository.query).mockResolvedValueOnce([
      {
        total_logs: '3',
        observed_logs: '3',
        legacy_unverified_logs: '0',
        last_24_hours: '2',
        by_action: [{ action: 'CREATE', count: '3' }],
        by_severity: [{ severity: 'info', count: '2' }],
        by_entity_type: [{ entityType: 'Tenant', count: '3' }],
        top_users: [{ userId: 'admin-1', email: 'admin@example.com', count: '3' }],
      },
    ]);

    await expect(service.getStatistics()).rejects.toThrow(ServiceUnavailableException);
  });

  it('propagates a rejected audit-page read instead of returning an authoritative empty page', async () => {
    const queryBuilder = {
      orderBy: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getManyAndCount: jest.fn().mockRejectedValue(new Error('audit source unavailable')),
    } as unknown as SelectQueryBuilder<AuditLog>;
    jest.mocked(repository.createQueryBuilder).mockReturnValue(queryBuilder);

    await expect(service.query({}, 1, 20)).rejects.toThrow('audit source unavailable');
  });
});
