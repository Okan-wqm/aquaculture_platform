/**
 * `resolveExternalPostgres` decides whether `bootPostgresContainer` starts a
 * container or uses the server named by `MIGRATION_HARNESS_PG_URL`. The
 * decision must be exact: unset means a container, a usable URL means that
 * server, and anything in between must throw — a suite that fell back to
 * Docker on a typo would be testing something other than what the operator
 * asked for, and would report it as green.
 */
import { EXTERNAL_POSTGRES_ENV, resolveExternalPostgres } from '../setup';

describe('resolveExternalPostgres', () => {
  it('returns undefined when the variable is unset or blank (container mode)', () => {
    expect(resolveExternalPostgres({})).toBeUndefined();
    expect(resolveExternalPostgres({ [EXTERNAL_POSTGRES_ENV]: '   ' })).toBeUndefined();
  });

  it('parses host, port, credentials and the maintenance database', () => {
    expect(
      resolveExternalPostgres({
        [EXTERNAL_POSTGRES_ENV]: 'postgres://harness:s3cret@127.0.0.1:5433/postgres',
      }),
    ).toEqual({
      host: '127.0.0.1',
      port: 5433,
      username: 'harness',
      password: 's3cret',
      maintenanceDatabase: 'postgres',
    });
  });

  it('defaults the port to 5432 and the maintenance database to postgres', () => {
    expect(
      resolveExternalPostgres({ [EXTERNAL_POSTGRES_ENV]: 'postgresql://harness:pw@db.internal' }),
    ).toEqual({
      host: 'db.internal',
      port: 5432,
      username: 'harness',
      password: 'pw',
      maintenanceDatabase: 'postgres',
    });
  });

  it('decodes percent-encoded credentials', () => {
    const target = resolveExternalPostgres({
      [EXTERNAL_POSTGRES_ENV]: 'postgres://har%40ness:p%3Ass@localhost:5432/maint',
    });
    expect(target?.username).toBe('har@ness');
    expect(target?.password).toBe('p:ss');
    expect(target?.maintenanceDatabase).toBe('maint');
  });

  it.each([
    ['not a URL', 'nope'],
    ['a non-postgres scheme', 'mysql://u:p@h:1/d'],
    ['a missing username', 'postgres://localhost:5432/db'],
    ['an invalid port', 'postgres://u:p@h:notaport/db'],
  ])('throws rather than falling back to a container on %s', (_label, value) => {
    expect(() => resolveExternalPostgres({ [EXTERNAL_POSTGRES_ENV]: value })).toThrow(
      EXTERNAL_POSTGRES_ENV,
    );
  });
});
