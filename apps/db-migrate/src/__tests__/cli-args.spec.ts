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

  it('returns empty args on argv that has only non-flag tokens', () => {
    // Non-flag tokens (bare positional args) are ignored — the CLI
    // only consumes its known flags. Future positional arg support
    // would land a separate commit + parser extension.
    const out = parseArgs(['ignoreme', 'positional']);
    expect(out).toEqual({});
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
