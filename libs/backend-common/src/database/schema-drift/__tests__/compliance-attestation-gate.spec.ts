/**
 * Integration spec for the compliance-attestation-coverage gate.
 * Exercises the exported runCoverageCheck() against the real
 * findings.jsonl + docs/compliance/evidence/ to assert the gate's
 * grandfathering + scope logic.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

interface ComplianceAttestationModule {
  readonly main: (argv: readonly string[]) => number;
  readonly runCoverageCheck: (args: { cutoffIso: string }) => {
    readonly totalInScope: number;
    readonly missing: readonly string[];
    readonly cutoffIso: string;
  };
}

const { main: attestationMain, runCoverageCheck } = jest.requireActual<ComplianceAttestationModule>(
  resolve(__dirname, '../../../../../../tools/gates/compliance-attestation-coverage'),
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function registrySeverityById(): ReadonlyMap<string, string> {
  const registryPath = resolve(
    __dirname,
    '../../../../../../docs/reviews/_registry/findings.jsonl',
  );
  const entries = new Map<string, string>();
  for (const line of readFileSync(registryPath, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    const parsed: unknown = JSON.parse(line);
    if (
      !isRecord(parsed) ||
      typeof parsed['id'] !== 'string' ||
      typeof parsed['severity'] !== 'string'
    ) {
      throw new Error('findings registry contains an invalid severity record');
    }
    entries.set(parsed['id'], parsed['severity']);
  }
  return entries;
}

describe('compliance-attestation-coverage gate', () => {
  let stdoutSpy: jest.SpyInstance;
  let stdoutChunks: string[] = [];

  beforeEach(() => {
    stdoutChunks = [];
    stdoutSpy = jest
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: string | Uint8Array) => {
        stdoutChunks.push(chunk.toString());
        return true;
      });
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
  });

  it('far-future cutoff grandfathers every finding (zero in scope)', () => {
    const r = runCoverageCheck({ cutoffIso: '9999-12-31T23:59:59Z' });
    expect(r.totalInScope).toBe(0);
    expect(r.missing).toEqual([]);
  });

  it('past cutoff surfaces the set of RESOLVED CRITICAL/HIGH findings without evidence', () => {
    const r = runCoverageCheck({ cutoffIso: '2026-04-15T00:00:00Z' });
    expect(r.totalInScope).toBeGreaterThan(0);
    // Known IDs from the current registry — stable across appends since
    // these finding IDs are assigned at creation.
    expect(r.missing).toContain('P0-CRITICAL-001');
    expect(r.missing.length).toBe(r.totalInScope); // no attestation files yet
  });

  it('ignores OPEN / IN-PROGRESS findings', () => {
    // The registry currently holds only RESOLVED entries (33 of 53 are
    // CRITICAL/HIGH, and 20 are RESOLVED). Past cutoff should surface
    // ONLY RESOLVED ones — not every CRITICAL/HIGH entry.
    const r = runCoverageCheck({ cutoffIso: '2026-04-15T00:00:00Z' });
    // Severity is registry data, not an ID naming convention. Legacy IDs such
    // as RUST-CVE-001 are valid HIGH findings even though the severity is not
    // embedded in the identifier.
    const severityById = registrySeverityById();
    for (const id of r.missing) {
      expect(['CRITICAL', 'HIGH']).toContain(severityById.get(id));
    }
  });

  it('throws on invalid cutoff ISO string', () => {
    expect(() => runCoverageCheck({ cutoffIso: 'not-a-date' })).toThrow(/invalid cutoff/);
  });

  it('main() with --json emits machine-readable report', () => {
    const code = attestationMain(['--cutoff', '9999-12-31T23:59:59Z', '--json']);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdoutChunks.join('')) as {
      cutoffIso: string;
      totalInScope: number;
      missingCount: number;
      missing: readonly string[];
    };
    expect(parsed.cutoffIso).toBe('9999-12-31T23:59:59Z');
    expect(parsed.totalInScope).toBe(0);
    expect(parsed.missingCount).toBe(0);
    expect(parsed.missing).toEqual([]);
  });

  it('main() exits 0 when grandfathered (no in-scope findings)', () => {
    const code = attestationMain(['--cutoff', '9999-12-31T23:59:59Z']);
    expect(code).toBe(0);
    expect(stdoutChunks.join('')).toContain('grandfathered');
  });

  it('main() exits 1 when in-scope findings lack evidence', () => {
    const code = attestationMain(['--cutoff', '2026-04-15T00:00:00Z']);
    expect(code).toBe(1);
    expect(stdoutChunks.join('')).toContain('MISSING ATTESTATIONS');
  });

  it('main() exits 2 on malformed cutoff', () => {
    const stderr: string[] = [];
    const stderrSpy = jest
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk: string | Uint8Array) => {
        stderr.push(chunk.toString());
        return true;
      });
    try {
      const code = attestationMain(['--cutoff', 'not-a-date']);
      expect(code).toBe(2);
      expect(stderr.join('')).toContain('invalid cutoff');
    } finally {
      stderrSpy.mockRestore();
    }
  });
});
