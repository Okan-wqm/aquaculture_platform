import { RECOVERY_POINT_QUERY, captureWalgRecoveryPoint } from '../recovery-point';

describe('captureWalgRecoveryPoint (ADR-0009)', () => {
  const now = (): Date => new Date('2026-09-05T12:00:00.000Z');

  it('asks the database for its WAL position and binds it to the archive epoch', async () => {
    const query = jest.fn().mockResolvedValue([{ walLsn: '0/1a2b3c4d', database: 'aquaculture' }]);

    const point = await captureWalgRecoveryPoint({ query }, 'epoch-20260716-001', now);

    expect(query).toHaveBeenCalledWith(RECOVERY_POINT_QUERY);
    expect(point).toEqual({
      authority: 'wal-g',
      backupEpoch: 'epoch-20260716-001',
      walLsn: '0/1A2B3C4D',
      database: 'aquaculture',
      capturedAt: '2026-09-05T12:00:00.000Z',
    });
    expect(Object.isFrozen(point)).toBe(true);
  });

  it('refuses to capture without an epoch — a drop must name the archive that can restore it', async () => {
    const query = jest.fn();
    await expect(captureWalgRecoveryPoint({ query }, undefined, now)).rejects.toThrow(
      'WALG_BACKUP_EPOCH is not set',
    );
    await expect(captureWalgRecoveryPoint({ query }, '   ', now)).rejects.toThrow(
      'WALG_BACKUP_EPOCH is not set',
    );
    expect(query).not.toHaveBeenCalled();
  });

  it('refuses a row that is not a WAL position', async () => {
    await expect(
      captureWalgRecoveryPoint({ query: jest.fn().mockResolvedValue([]) }, 'epoch', now),
    ).rejects.toThrow('returned no WAL position');
    await expect(
      captureWalgRecoveryPoint(
        { query: jest.fn().mockResolvedValue([{ walLsn: 'garbage', database: 'db' }]) },
        'epoch',
        now,
      ),
    ).rejects.toThrow('invalid WAL LSN');
  });
});
