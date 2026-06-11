import { parseArgs } from '../cli-args';

/**
 * Unit tests for the `--down N --schema <name>` rollback CLI
 * parser (ORPHAN-020). The parser is the OPERATOR boundary — a
 * malformed invocation should fail at parseArgs with a clear
 * error, never reach the DB.
 */

describe('parseArgs — default (no flags)', () => {
  it('returns empty args on an empty argv', () => {
    const out = parseArgs([]);
    expect(out).toEqual({});
  });

  it('rejects unknown positional tokens (PR#363 port — typo fail-loud)', () => {
    // Pre-port behaviour silently ignored unknown positionals, so a
    // typo'd subcommand (`tenant-schema-provisioneer`) degraded to the
    // default up-all migration run. Operator CLIs fail at the boundary.
    expect(() => parseArgs(['ignoreme', 'positional'])).toThrow(
      /unexpected positional argument/i,
    );
  });
});

describe('parseArgs — duplicate and value-eating flags (PR#363 port)', () => {
  it('rejects duplicate --down', () => {
    expect(() => parseArgs(['--down', '2', '--down', '3', '--schema', 'farm'])).toThrow(
      /duplicate cli flag: --down/i,
    );
  });

  it('rejects duplicate --schema', () => {
    expect(() => parseArgs(['--down', '2', '--schema', 'farm', '--schema', 'hr'])).toThrow(
      /duplicate cli flag: --schema/i,
    );
  });

  it('rejects duplicate --tenant', () => {
    expect(() =>
      parseArgs([
        'tenant-schema-rollback',
        '--tenant',
        'tenant_4b529829ea7948da',
        '--tenant',
        'tenant_5c640940fb805aeb',
        '--down',
        '1',
        '--schema',
        'farm',
      ]),
    ).toThrow(/duplicate cli flag: --tenant/i);
  });

  it('rejects --down swallowing the next flag as its value', () => {
    expect(() => parseArgs(['--down', '--schema', 'farm'])).toThrow(/requires an integer/i);
  });

  it('rejects --schema swallowing the next flag as its value', () => {
    expect(() => parseArgs(['--down', '1', '--schema', '--down'])).toThrow(
      /requires a schema name/i,
    );
  });

  it('rejects --tenant swallowing the next flag as its value', () => {
    expect(() =>
      parseArgs(['tenant-schema-rollback', '--tenant', '--down', '1', '--schema', 'farm']),
    ).toThrow(/requires a tenant id/i);
  });
});

describe('parseArgs — --down N --schema <name> happy path', () => {
  it('parses --down 1 --schema admin', () => {
    const out = parseArgs(['--down', '1', '--schema', 'admin']);
    expect(out).toEqual({ down: 1, schema: 'admin' });
  });

  it('parses --schema first then --down N', () => {
    // Flag order should not matter.
    const out = parseArgs(['--schema', 'sensor', '--down', '3']);
    expect(out).toEqual({ down: 3, schema: 'sensor' });
  });

  it('accepts --down 100 (large count)', () => {
    const out = parseArgs(['--down', '100', '--schema', 'admin']);
    expect(out.down).toBe(100);
  });
});

describe('parseArgs — tenant-schema-provisioner mode', () => {
  it('defaults tenant-schema-provisioner to one claim', () => {
    const out = parseArgs(['tenant-schema-provisioner']);
    expect(out).toEqual({
      mode: 'tenant-schema-provisioner',
      provisionerRunMode: 'once',
    });
  });

  it('parses tenant-schema-provisioner --once', () => {
    const out = parseArgs(['tenant-schema-provisioner', '--once']);
    expect(out).toEqual({
      mode: 'tenant-schema-provisioner',
      provisionerRunMode: 'once',
    });
  });

  it('parses tenant-schema-provisioner --loop', () => {
    const out = parseArgs(['tenant-schema-provisioner', '--loop']);
    expect(out).toEqual({
      mode: 'tenant-schema-provisioner',
      provisionerRunMode: 'loop',
    });
  });

  it('rejects provisioner mode combined with rollback flags', () => {
    expect(() =>
      parseArgs(['tenant-schema-provisioner', '--down', '1', '--schema', 'farm']),
    ).toThrow(/cannot be combined/i);
  });

  it('rejects provisioner run flags without provisioner mode', () => {
    expect(() => parseArgs(['--once'])).toThrow(/only accepted after/i);
  });
});

describe('parseArgs — tenant-schema-rollback mode', () => {
  it('parses tenant rollback for one tenant schema', () => {
    const out = parseArgs([
      'tenant-schema-rollback',
      '--tenant',
      'tenant_1234567890abcdef',
      '--schema',
      'farm',
      '--down',
      '2',
    ]);
    expect(out).toEqual({
      mode: 'tenant-schema-rollback',
      tenantRollbackTarget: 'tenant',
      tenantRollbackTenant: 'tenant_1234567890abcdef',
      schema: 'farm',
      down: 2,
    });
  });

  it('parses tenant rollback fan-out for all tenants', () => {
    const out = parseArgs(['tenant-schema-rollback', '--all', '--schema', 'farm', '--down', '1']);
    expect(out).toEqual({
      mode: 'tenant-schema-rollback',
      tenantRollbackTarget: 'all',
      schema: 'farm',
      down: 1,
    });
  });

  it('rejects tenant rollback without an explicit tenant scope', () => {
    expect(() =>
      parseArgs(['tenant-schema-rollback', '--schema', 'farm', '--down', '1']),
    ).toThrow(/requires --tenant <id> or --all/i);
  });

  it('rejects tenant rollback without source schema and down count', () => {
    expect(() => parseArgs(['tenant-schema-rollback', '--all'])).toThrow(
      /requires --schema <source> --down <N>/i,
    );
  });

  it('rejects mixed tenant rollback scopes', () => {
    expect(() =>
      parseArgs(['tenant-schema-rollback', '--all', '--tenant', 'tenant_1234567890abcdef']),
    ).toThrow(/only one of --tenant or --all/i);
  });
});

describe('parseArgs — --down rejects malformed argument', () => {
  it('rejects --down with no argument', () => {
    expect(() => parseArgs(['--down'])).toThrow(/requires an integer/i);
  });

  it('rejects --down 0 (must be positive)', () => {
    expect(() => parseArgs(['--down', '0', '--schema', 'admin'])).toThrow(
      /positive integer/i,
    );
  });

  it('rejects --down -1 (negative)', () => {
    expect(() => parseArgs(['--down', '-1', '--schema', 'admin'])).toThrow(
      /positive integer/i,
    );
  });

  it('rejects --down abc (non-numeric)', () => {
    expect(() => parseArgs(['--down', 'abc', '--schema', 'admin'])).toThrow(
      /positive integer/i,
    );
  });

  it('rejects --down 1.5 (non-integer — parseInt would truncate silently)', () => {
    // parseInt('1.5', 10) === 1, which would silently roll back the
    // wrong count. Reject so the operator sees the typo.
    expect(() => parseArgs(['--down', '1.5', '--schema', 'admin'])).toThrow(
      /positive integer/i,
    );
  });
});

describe('parseArgs — --schema rejects malformed argument', () => {
  it('rejects --schema with no argument', () => {
    expect(() =>
      parseArgs(['--down', '1', '--schema']),
    ).toThrow(/requires a schema name/i);
  });

  it('rejects --schema ""', () => {
    expect(() =>
      parseArgs(['--down', '1', '--schema', '']),
    ).toThrow(/requires a schema name/i);
  });
});

describe('parseArgs — cross-flag validation', () => {
  it('rejects bare --down 1 without --schema (blast-radius guard)', () => {
    expect(() => parseArgs(['--down', '1'])).toThrow(/requires --schema/i);
  });

  it('rejects --schema without --down (schema is a rollback-only modifier)', () => {
    expect(() => parseArgs(['--schema', 'admin'])).toThrow(
      /only accepted alongside --down/i,
    );
  });

  it('rejects unknown --foo flag', () => {
    expect(() => parseArgs(['--foo', 'bar'])).toThrow(/unknown cli flag/i);
  });

  it('rejects --help (not a supported flag — dedicated `help` subcommand is out of plan scope)', () => {
    expect(() => parseArgs(['--help'])).toThrow(/unknown cli flag/i);
  });
});
