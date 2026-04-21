import { ConfigService } from '@nestjs/config';
import type { LessThan, Repository } from 'typeorm';

import { MigrationEventsRetentionService } from '../migration-events-retention.service';
import type { MigrationEventEntity } from '../../../database/entities/migration-event.entity';

function makeConfig(overrides: Record<string, string> = {}): ConfigService {
  return {
    get: jest.fn((key: string, defaultValue?: string) =>
      overrides[key] ?? defaultValue,
    ),
  } as unknown as ConfigService;
}

function makeRepo(
  deletedAffected: number,
): jest.Mocked<Repository<MigrationEventEntity>> {
  return {
    delete: jest.fn(async () => ({ affected: deletedAffected, raw: {} })),
  } as unknown as jest.Mocked<Repository<MigrationEventEntity>>;
}

describe('MigrationEventsRetentionService', () => {
  it('defaults to 395-day retention (≈13 months) when env var unset', async () => {
    const repo = makeRepo(0);
    const cfg = makeConfig();
    const svc = new MigrationEventsRetentionService(repo, cfg);
    const now = new Date('2026-04-21T03:00:00.000Z');
    await svc.enforceOnce(now);

    const deleteCall = (repo.delete as jest.Mock).mock.calls[0]![0] as {
      occurredAt: ReturnType<typeof LessThan>;
    };
    // Extract cutoff from LessThan(...) instance — TypeORM's LessThan
    // exposes value via ._value (implementation detail but stable since 0.3).
    const cutoff = (deleteCall.occurredAt as unknown as { _value: Date })
      ._value;
    // 395 days before 2026-04-21.
    const expectedCutoff = new Date(
      now.getTime() - 395 * 86_400_000,
    ).toISOString();
    expect(cutoff).toBeInstanceOf(Date);
    expect(cutoff.toISOString()).toBe(expectedCutoff);
  });

  it('respects MIGRATION_EVENTS_RETENTION_DAYS env override', async () => {
    const repo = makeRepo(0);
    const cfg = makeConfig({ MIGRATION_EVENTS_RETENTION_DAYS: '30' });
    const svc = new MigrationEventsRetentionService(repo, cfg);
    const now = new Date('2026-04-21T03:00:00.000Z');
    await svc.enforceOnce(now);

    const deleteCall = (repo.delete as jest.Mock).mock.calls[0]![0] as {
      occurredAt: { _value: Date };
    };
    const cutoff = deleteCall.occurredAt._value;
    const expectedCutoff = new Date(
      now.getTime() - 30 * 86_400_000,
    ).toISOString();
    expect(cutoff.toISOString()).toBe(expectedCutoff);
  });

  it('returns the number of rows deleted', async () => {
    const repo = makeRepo(42);
    const cfg = makeConfig();
    const svc = new MigrationEventsRetentionService(repo, cfg);
    const count = await svc.enforceOnce();
    expect(count).toBe(42);
  });

  it('returns 0 when no rows are old enough', async () => {
    const repo = makeRepo(0);
    const cfg = makeConfig();
    const svc = new MigrationEventsRetentionService(repo, cfg);
    const count = await svc.enforceOnce();
    expect(count).toBe(0);
  });

  it('rejects non-integer retention value at construction', () => {
    const repo = makeRepo(0);
    const cfg = makeConfig({ MIGRATION_EVENTS_RETENTION_DAYS: 'not-a-number' });
    expect(() => new MigrationEventsRetentionService(repo, cfg)).toThrow(
      /positive integer/,
    );
  });

  it('rejects retention value < 1 (no instant-delete)', () => {
    const repo = makeRepo(0);
    const cfg = makeConfig({ MIGRATION_EVENTS_RETENTION_DAYS: '0' });
    expect(() => new MigrationEventsRetentionService(repo, cfg)).toThrow(
      /positive integer/,
    );
  });

  it('enforce() delegates to enforceOnce() (Cron entrypoint)', async () => {
    const repo = makeRepo(5);
    const cfg = makeConfig();
    const svc = new MigrationEventsRetentionService(repo, cfg);
    const spy = jest.spyOn(svc, 'enforceOnce');
    await svc.enforce();
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
