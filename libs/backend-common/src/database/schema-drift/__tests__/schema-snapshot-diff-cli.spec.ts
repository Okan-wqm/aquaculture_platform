/**
 * Integration spec for the tools/gates/schema-snapshot-diff CLI.
 * Exercises the exported main() against real temp files, captures
 * stdout/stderr + exit code.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import type { SchemaSnapshot } from '../pg-catalog-introspector';

interface SchemaSnapshotDiffModule {
  readonly main: (argv: readonly string[]) => Promise<number>;
}

const { main: snapshotDiffMain } = jest.requireActual<SchemaSnapshotDiffModule>(
  resolve(__dirname, '../../../../../../tools/gates/schema-snapshot-diff'),
);

function makeSnapshot(overrides: Partial<SchemaSnapshot> = {}): SchemaSnapshot {
  return {
    schema: 'hr',
    tables: [],
    enums: [],
    checkConstraints: [],
    partialIndexes: [],
    excludeConstraints: [],
    foreignKeyActions: [],
    generatedColumns: [],
    hypertables: [],
    rlsPolicies: [],
    capturedAt: '2026-04-21T09:00:00.000Z',
    ...overrides,
  };
}

describe('schema-snapshot-diff CLI', () => {
  let tmp: string;
  let beforePath: string;
  let afterPath: string;
  let stdoutSpy: jest.SpyInstance;
  let stderrSpy: jest.SpyInstance;
  let stdoutChunks: string[] = [];
  let stderrChunks: string[] = [];

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'snapdiff-'));
    beforePath = join(tmp, 'before.json');
    afterPath = join(tmp, 'after.json');
    stdoutChunks = [];
    stderrChunks = [];
    stdoutSpy = jest
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: string | Uint8Array) => {
        stdoutChunks.push(chunk.toString());
        return true;
      });
    stderrSpy = jest
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk: string | Uint8Array) => {
        stderrChunks.push(chunk.toString());
        return true;
      });
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('exits 0 for empty diff', async () => {
    writeFileSync(beforePath, JSON.stringify(makeSnapshot()));
    writeFileSync(afterPath, JSON.stringify(makeSnapshot()));
    const code = await snapshotDiffMain([
      '--before',
      beforePath,
      '--after',
      afterPath,
      '--schema',
      'hr',
    ]);
    expect(code).toBe(0);
    expect(stdoutChunks.join('')).toContain('0 total change(s)');
  });

  it('exits 1 when breaking changes exist (table_removed)', async () => {
    const before = makeSnapshot({
      tables: [{ schema: 'hr', name: 'legacy', columns: [] }],
    });
    writeFileSync(beforePath, JSON.stringify(before));
    writeFileSync(afterPath, JSON.stringify(makeSnapshot()));
    const code = await snapshotDiffMain([
      '--before',
      beforePath,
      '--after',
      afterPath,
      '--schema',
      'hr',
    ]);
    expect(code).toBe(1);
    expect(stdoutChunks.join('')).toContain('table_removed');
    expect(stdoutChunks.join('')).toContain('BREAKING');
  });

  it('exits 0 on --allow-breaking bypass', async () => {
    const before = makeSnapshot({
      tables: [{ schema: 'hr', name: 'legacy', columns: [] }],
    });
    writeFileSync(beforePath, JSON.stringify(before));
    writeFileSync(afterPath, JSON.stringify(makeSnapshot()));
    const code = await snapshotDiffMain([
      '--before',
      beforePath,
      '--after',
      afterPath,
      '--schema',
      'hr',
      '--allow-breaking',
    ]);
    expect(code).toBe(0);
    expect(stdoutChunks.join('')).toContain('--allow-breaking passed');
  });

  it('exits 0 for expand-only changes (table_added)', async () => {
    writeFileSync(beforePath, JSON.stringify(makeSnapshot()));
    const after = makeSnapshot({
      tables: [{ schema: 'hr', name: 'new_table', columns: [] }],
    });
    writeFileSync(afterPath, JSON.stringify(after));
    const code = await snapshotDiffMain([
      '--before',
      beforePath,
      '--after',
      afterPath,
      '--schema',
      'hr',
    ]);
    expect(code).toBe(0);
    expect(stdoutChunks.join('')).toContain('EXPAND');
  });

  it('emits JSON report on --json flag', async () => {
    const before = makeSnapshot({
      tables: [{ schema: 'hr', name: 'legacy', columns: [] }],
    });
    writeFileSync(beforePath, JSON.stringify(before));
    writeFileSync(afterPath, JSON.stringify(makeSnapshot()));
    const code = await snapshotDiffMain([
      '--before',
      beforePath,
      '--after',
      afterPath,
      '--schema',
      'hr',
      '--json',
    ]);
    expect(code).toBe(1);
    const out = JSON.parse(stdoutChunks.join('')) as {
      totalChanges: number;
      breakingCount: number;
      changes: Array<{ kind: string }>;
    };
    expect(out.totalChanges).toBe(1);
    expect(out.breakingCount).toBe(1);
    expect(out.changes[0]?.kind).toBe('table_removed');
  });

  it('exits 2 on missing --schema arg', async () => {
    const code = await snapshotDiffMain(['--before', beforePath, '--after', afterPath]);
    expect(code).toBe(2);
    expect(stderrChunks.join('')).toContain('argument error');
  });

  it('exits 2 on schema-name mismatch between inputs', async () => {
    const before = makeSnapshot({ schema: 'hr' });
    const after = makeSnapshot({ schema: 'farm' });
    writeFileSync(beforePath, JSON.stringify(before));
    writeFileSync(afterPath, JSON.stringify(after));
    const code = await snapshotDiffMain([
      '--before',
      beforePath,
      '--after',
      afterPath,
      '--schema',
      'hr',
    ]);
    expect(code).toBe(2);
    expect(stderrChunks.join('')).toContain('schema mismatch');
  });

  it('exits 2 on malformed JSON', async () => {
    writeFileSync(beforePath, 'not-json');
    writeFileSync(afterPath, JSON.stringify(makeSnapshot()));
    const code = await snapshotDiffMain([
      '--before',
      beforePath,
      '--after',
      afterPath,
      '--schema',
      'hr',
    ]);
    expect(code).toBe(2);
    expect(stderrChunks.join('')).toContain('input error');
  });
});
