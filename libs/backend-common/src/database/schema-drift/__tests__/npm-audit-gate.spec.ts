/**
 * Unit tests for tools/gates/npm-audit.ts. Exercises the pure
 * parseArgs + summarize + runCheck entry points with synthetic
 * NpmAuditReport fixtures — no real `npm audit` subprocess.
 */
import { resolve } from 'node:path';

type Severity = 'critical' | 'high' | 'moderate' | 'low' | 'info';

interface NpmAuditArgs {
  readonly failOn: Severity;
  readonly allowlist: ReadonlySet<number>;
  readonly jsonMode: boolean;
}

interface NpmAuditSummary {
  readonly blocking: ReadonlyArray<{
    readonly module: string;
    readonly severity: Severity;
    readonly advisoryId: number | null;
    readonly title: string;
  }>;
  readonly countsBySeverity: Record<Severity, number>;
}

interface NpmAuditModule {
  readonly parseArgs: (argv: readonly string[]) => NpmAuditArgs;
  readonly summarize: (report: unknown, args: NpmAuditArgs) => NpmAuditSummary;
  readonly runCheck: (
    report: unknown,
    args: NpmAuditArgs,
  ) => { readonly exitCode: 0 | 1; readonly summary: NpmAuditSummary };
}

const { parseArgs, summarize, runCheck } = jest.requireActual<NpmAuditModule>(
  resolve(__dirname, '../../../../../../tools/gates/npm-audit'),
);

describe('npm-audit parseArgs', () => {
  it('defaults to failOn=high when unspecified', () => {
    const a = parseArgs([]);
    expect(a.failOn).toBe('high');
    expect(a.allowlist.size).toBe(0);
    expect(a.jsonMode).toBe(false);
  });

  it('honors --fail-on value', () => {
    expect(parseArgs(['--fail-on', 'critical']).failOn).toBe('critical');
    expect(parseArgs(['--fail-on', 'moderate']).failOn).toBe('moderate');
  });

  it('rejects invalid --fail-on', () => {
    expect(() => parseArgs(['--fail-on', 'info'])).toThrow(/critical\|high\|moderate\|low/);
    expect(() => parseArgs(['--fail-on', 'nonsense'])).toThrow();
  });

  it('parses comma-separated --allow ids', () => {
    const a = parseArgs(['--allow', '111,222,333']);
    expect(a.allowlist.has(111)).toBe(true);
    expect(a.allowlist.has(222)).toBe(true);
    expect(a.allowlist.has(333)).toBe(true);
    expect(a.allowlist.has(999)).toBe(false);
  });

  it('rejects non-numeric --allow entries', () => {
    expect(() => parseArgs(['--allow', 'abc,def'])).toThrow(/numeric/);
  });

  it('--json sets jsonMode=true', () => {
    expect(parseArgs(['--json']).jsonMode).toBe(true);
  });

  it('rejects unknown argument', () => {
    expect(() => parseArgs(['--nonsense'])).toThrow(/unknown argument/);
  });
});

describe('npm-audit summarize', () => {
  const sampleReport = {
    vulnerabilities: {
      'lodash-typo': {
        severity: 'high',
        name: 'lodash-typo',
        via: [
          {
            id: 1001,
            severity: 'high',
            title: 'Prototype pollution',
            url: 'https://example.test/1001',
          },
        ],
      },
      'moment-old': {
        severity: 'moderate',
        name: 'moment-old',
        via: [
          {
            id: 2002,
            severity: 'moderate',
            title: 'ReDoS',
          },
        ],
      },
      'example-pkg': {
        severity: 'low',
        name: 'example-pkg',
        via: [{ id: 3003, severity: 'low', title: 'Info disclosure' }],
      },
      'transitive-only': {
        severity: 'critical',
        name: 'transitive-only',
        // via is just a module name → no advisory object, still blocking
        via: ['upstream-pkg'],
      },
    },
  };

  it('blocks on advisories ≥ failOn threshold (default high)', () => {
    const args = parseArgs([]);
    const s = summarize(sampleReport, args);
    // high + critical (transitive) = 2 blocking; moderate + low excluded.
    expect(s.blocking).toHaveLength(2);
    const modules = s.blocking.map((b) => b.module).sort();
    expect(modules).toEqual(['lodash-typo', 'transitive-only']);
    expect(s.countsBySeverity).toEqual({
      critical: 1,
      high: 1,
      moderate: 1,
      low: 1,
      info: 0,
    });
  });

  it('tighter threshold (critical) surfaces only critical', () => {
    const args = parseArgs(['--fail-on', 'critical']);
    const s = summarize(sampleReport, args);
    expect(s.blocking).toHaveLength(1);
    expect(s.blocking[0]?.module).toBe('transitive-only');
  });

  it('looser threshold (moderate) includes high + moderate + critical', () => {
    const args = parseArgs(['--fail-on', 'moderate']);
    const s = summarize(sampleReport, args);
    expect(s.blocking.length).toBe(3); // critical + high + moderate
  });

  it('allowlist suppresses specific advisory ids', () => {
    const args = parseArgs(['--allow', '1001']);
    const s = summarize(sampleReport, args);
    // lodash-typo's advisory 1001 was allowlisted — drops to 1 blocking.
    expect(s.blocking).toHaveLength(1);
    expect(s.blocking[0]?.module).toBe('transitive-only');
  });

  it('empty vulnerabilities report → zero blocking', () => {
    const args = parseArgs([]);
    const s = summarize({ vulnerabilities: {} }, args);
    expect(s.blocking).toEqual([]);
    expect(Object.values(s.countsBySeverity).every((n) => n === 0)).toBe(true);
  });

  it('missing vulnerabilities key → zero blocking (robust against npm@6 shape)', () => {
    const args = parseArgs([]);
    const s = summarize({}, args);
    expect(s.blocking).toEqual([]);
  });
});

describe('npm-audit runCheck exit codes', () => {
  it('exit 0 when no blocking', () => {
    const args = parseArgs([]);
    const r = runCheck({ vulnerabilities: {} }, args);
    expect(r.exitCode).toBe(0);
  });

  it('exit 1 when blocking present', () => {
    const args = parseArgs(['--fail-on', 'high']);
    const r = runCheck(
      {
        vulnerabilities: {
          foo: {
            severity: 'high',
            name: 'foo',
            via: [{ id: 1, severity: 'high', title: 'x' }],
          },
        },
      },
      args,
    );
    expect(r.exitCode).toBe(1);
  });
});
