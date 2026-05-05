/**
 * Unit tests for tools/aqua-ctl/aqua-ctl.ts. Exercises the parser +
 * in-memory runDriftBypass path — no real DB connection, no pg driver.
 */

// `export {}` keeps strict-tsc treating this file as a MODULE so its
// top-level declarations stay file-scoped (PROC-MEDIUM-010 invariant).
export {};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const {
  parseTtl,
  parseDriftBypassArgs,
  resolveActor,
  runDriftBypass,
} = require('../../../../../../tools/aqua-ctl/aqua-ctl') as {
  parseTtl: (s: string) => number;
  resolveActor: (env: NodeJS.ProcessEnv) => string;
  parseDriftBypassArgs: (
    argv: readonly string[],
    env?: NodeJS.ProcessEnv,
  ) => {
    service: string;
    reason: string;
    ttlMs: number;
    environment: string;
    actor: string;
    dryRun: boolean;
  };
  runDriftBypass: (
    args: {
      service: string;
      reason: string;
      ttlMs: number;
      environment: string;
      actor: string;
      dryRun: boolean;
    },
    writer: {
      write: (a: {
        service: string;
        reason: string;
        expiresAt: Date;
        actor: string;
        environment: string;
      }) => Promise<{ id: string }>;
    },
    now?: Date,
  ) => Promise<{ id: string; dryRun: boolean }>;
};

describe('parseTtl', () => {
  it.each([
    ['1m', 60_000],
    ['30m', 30 * 60_000],
    ['2h', 2 * 3_600_000],
    ['1d', 86_400_000],
    ['7d', 7 * 86_400_000],
  ])('parses %s → %d ms', (input, expected) => {
    expect(parseTtl(input)).toBe(expected);
  });

  it('rejects short TTL under 1m', () => {
    expect(() => parseTtl('30s')).toThrow(/at least 1m/);
  });

  it('rejects TTL over 7 days', () => {
    expect(() => parseTtl('8d')).toThrow(/at most 7d/);
  });

  it('rejects malformed input', () => {
    expect(() => parseTtl('two hours')).toThrow(/<number><s\|m\|h\|d>/);
    expect(() => parseTtl('')).toThrow();
    expect(() => parseTtl('10x')).toThrow();
  });
});

describe('resolveActor', () => {
  it('prefers GITHUB_USER over SUDO_USER over USER', () => {
    expect(
      resolveActor({ GITHUB_USER: 'okan', SUDO_USER: 'root2', USER: 'u' }),
    ).toBe('okan');
    expect(resolveActor({ SUDO_USER: 'sudo', USER: 'u' })).toBe('sudo');
    expect(resolveActor({ USER: 'u' })).toBe('u');
  });

  it('ignores "root" as a bare attribution', () => {
    expect(() => resolveActor({ USER: 'root' })).toThrow(/cannot resolve actor/);
  });

  it('throws when no attribution source is available', () => {
    expect(() => resolveActor({})).toThrow(/cannot resolve actor/);
  });
});

describe('parseDriftBypassArgs', () => {
  const baseEnv = { GITHUB_USER: 'okan' };

  it('parses a valid invocation', () => {
    const args = parseDriftBypassArgs(
      ['--service', 'hr', '--reason', 'INC-123', '--ttl', '2h'],
      baseEnv,
    );
    expect(args).toEqual({
      service: 'hr',
      reason: 'INC-123',
      ttlMs: 7_200_000,
      environment: 'development',
      actor: 'okan',
      dryRun: false,
    });
  });

  it('requires --service', () => {
    expect(() =>
      parseDriftBypassArgs(['--reason', 'r', '--ttl', '1h'], baseEnv),
    ).toThrow(/--service is required/);
  });

  it('rejects unsafe --service identifiers', () => {
    expect(() =>
      parseDriftBypassArgs(
        ['--service', 'hr; DROP--', '--reason', 'r', '--ttl', '1h'],
        baseEnv,
      ),
    ).toThrow(/must match/);
  });

  it('requires --reason', () => {
    expect(() =>
      parseDriftBypassArgs(['--service', 'hr', '--ttl', '1h'], baseEnv),
    ).toThrow(/--reason is required/);
  });

  it('rejects empty --reason', () => {
    expect(() =>
      parseDriftBypassArgs(
        ['--service', 'hr', '--reason', '   ', '--ttl', '1h'],
        baseEnv,
      ),
    ).toThrow(/--reason is required/);
  });

  it('requires --ttl', () => {
    expect(() =>
      parseDriftBypassArgs(['--service', 'hr', '--reason', 'r'], baseEnv),
    ).toThrow(/--ttl is required/);
  });

  it('honors --dry-run flag', () => {
    const args = parseDriftBypassArgs(
      ['--service', 'hr', '--reason', 'r', '--ttl', '1h', '--dry-run'],
      baseEnv,
    );
    expect(args.dryRun).toBe(true);
  });

  it('honors --environment override', () => {
    const args = parseDriftBypassArgs(
      [
        '--service',
        'hr',
        '--reason',
        'r',
        '--ttl',
        '1h',
        '--environment',
        'production',
      ],
      baseEnv,
    );
    expect(args.environment).toBe('production');
  });

  it('defaults environment from AQUA_ENV', () => {
    const args = parseDriftBypassArgs(
      ['--service', 'hr', '--reason', 'r', '--ttl', '1h'],
      { ...baseEnv, AQUA_ENV: 'staging' },
    );
    expect(args.environment).toBe('staging');
  });
});

describe('runDriftBypass', () => {
  it('writes via the supplied writer + returns its id', async () => {
    const fakeWriter = {
      write: jest.fn(async () => ({ id: 'row-abc' })),
    };
    const result = await runDriftBypass(
      {
        service: 'hr',
        reason: 'INC-123',
        ttlMs: 3_600_000,
        environment: 'staging',
        actor: 'okan',
        dryRun: false,
      },
      fakeWriter,
      new Date('2026-04-21T12:00:00.000Z'),
    );
    expect(result).toEqual({ id: 'row-abc', dryRun: false });
    expect(fakeWriter.write).toHaveBeenCalledTimes(1);
    const calls = fakeWriter.write.mock.calls as unknown as Array<
      readonly [
        {
          service: string;
          reason: string;
          expiresAt: Date;
          actor: string;
          environment: string;
        },
      ]
    >;
    const call = calls[0]?.[0];
    expect(call).toBeDefined();
    expect(call!.service).toBe('hr');
    expect(call!.expiresAt.toISOString()).toBe('2026-04-21T13:00:00.000Z');
  });

  it('--dry-run skips the writer entirely', async () => {
    const fakeWriter = {
      write: jest.fn(async () => ({ id: 'never' })),
    };
    const result = await runDriftBypass(
      {
        service: 'hr',
        reason: 'INC-123',
        ttlMs: 60_000,
        environment: 'staging',
        actor: 'okan',
        dryRun: true,
      },
      fakeWriter,
    );
    expect(result.dryRun).toBe(true);
    expect(result.id).toBe('<dry-run>');
    expect(fakeWriter.write).not.toHaveBeenCalled();
  });
});
