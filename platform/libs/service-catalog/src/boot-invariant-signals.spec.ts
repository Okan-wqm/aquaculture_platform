import {
  BOOT_INVARIANT_SIGNALS,
  bootInvariantSignalRecord,
  emitBootInvariantSignal,
} from './boot-invariant-signals';

describe('boot invariant signal contract', () => {
  it('pins exact deploy signal patterns', () => {
    expect(BOOT_INVARIANT_SIGNALS.schema_drift_clean.pattern).toBe('Schema drift scan clean');
    expect(BOOT_INVARIANT_SIGNALS.nats_auth_mode_mtls.pattern).toBe('NATS auth mode: mtls-cert');
    expect(BOOT_INVARIANT_SIGNALS.db_migrate_complete.pattern).toBe('aqua-db-migrate complete');
  });

  it('builds a structured ok record without allowing metadata overrides', () => {
    expect(
      bootInvariantSignalRecord('schema_drift_clean', {
        message: 'wrong',
        bootSignal: 'wrong',
        status: 'wrong',
        checkedOwnedEntities: 3,
      }),
    ).toEqual({
      message: 'Schema drift scan clean',
      bootSignal: 'schema_drift_clean',
      status: 'ok',
      checkedOwnedEntities: 3,
    });
  });

  it('emits message plus structured fields through a logger', () => {
    const logger = { log: jest.fn() };

    const record = emitBootInvariantSignal(logger, 'db_migrate_complete', {
      totalAppliedMigrations: 2,
    });

    expect(record).toEqual({
      message: 'aqua-db-migrate complete',
      bootSignal: 'db_migrate_complete',
      status: 'ok',
      totalAppliedMigrations: 2,
    });
    expect(logger.log).toHaveBeenCalledWith('aqua-db-migrate complete', {
      bootSignal: 'db_migrate_complete',
      status: 'ok',
      totalAppliedMigrations: 2,
    });
  });
});
