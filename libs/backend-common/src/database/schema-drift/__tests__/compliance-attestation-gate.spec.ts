/**
 * Integration spec for the compliance-attestation-coverage gate.
 * Exercises the exported runCoverageCheck() against the real
 * findings.jsonl + docs/compliance/evidence/ to assert the gate's
 * grandfathering + scope logic.
 */

// `export {}` keeps strict-tsc treating this file as a MODULE so its
// top-level declarations stay file-scoped (PROC-MEDIUM-010 invariant).
export {};
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const {
  main: attestationMain,
  runCoverageCheck,
} = require('../../../../../../tools/gates/compliance-attestation-coverage') as {
  main: (argv: readonly string[]) => number;
  runCoverageCheck: (args: { cutoffIso: string }) => {
    totalInScope: number;
    missing: readonly string[];
    cutoffIso: string;
  };
};

/**
 * Registry rows as the gate reads them. Parsed here rather than imported so
 * the spec checks the gate against the SAME on-disk source of truth the gate
 * consults, instead of against the gate's own in-memory view of it.
 */
function readRegistryEntries(): Array<{
  id: string;
  severity: string;
  state: string;
}> {
  const registryPath = join(
    __dirname,
    '..',
    '..',
    '..',
    '..',
    '..',
    '..',
    'docs',
    'reviews',
    '_registry',
    'findings.jsonl',
  );
  return readFileSync(registryPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as { id: string; severity: string; state: string });
}

describe('compliance-attestation-coverage gate', () => {
  let stdoutSpy: jest.SpyInstance;
  let stdoutChunks: string[] = [];

  beforeEach(() => {
    stdoutChunks = [];
    stdoutSpy = jest
      .spyOn(process.stdout, 'write')
      .mockImplementation(((chunk: string | Uint8Array) => {
        stdoutChunks.push(chunk.toString());
        return true;
      }) as never);
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
    // Past cutoff must surface ONLY RESOLVED CRITICAL/HIGH entries.
    //
    // This used to assert `id` matched /-(CRITICAL|HIGH)-/, reading severity
    // out of the ID TEXT. That is not where severity lives — the gate itself
    // filters on `e.severity`, and the ID convention `{DOMAIN}-{SEVERITY}-{N}`
    // is a convention, not a schema. `RUST-CVE-001` is a legitimately-shaped
    // registry entry with `"severity":"HIGH"` and no severity segment in its
    // ID, so the regex failed a finding the gate had classified correctly.
    // Assert against the registry field the gate actually reads.
    const bySeverity = new Map(
      readRegistryEntries().map((e) => [e.id, e]),
    );
    const r = runCoverageCheck({ cutoffIso: '2026-04-15T00:00:00Z' });
    const misclassified = r.missing.filter((id) => {
      const entry = bySeverity.get(id);
      return (
        !entry ||
        entry.state !== 'RESOLVED' ||
        (entry.severity !== 'CRITICAL' && entry.severity !== 'HIGH')
      );
    });
    expect(misclassified).toEqual([]);
  });

  it('throws on invalid cutoff ISO string', () => {
    expect(() => runCoverageCheck({ cutoffIso: 'not-a-date' })).toThrow(
      /invalid cutoff/,
    );
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
      .mockImplementation(((chunk: string | Uint8Array) => {
        stderr.push(chunk.toString());
        return true;
      }) as never);
    try {
      const code = attestationMain(['--cutoff', 'not-a-date']);
      expect(code).toBe(2);
      expect(stderr.join('')).toContain('invalid cutoff');
    } finally {
      stderrSpy.mockRestore();
    }
  });
});
