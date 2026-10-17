/**
 * The invariant suite's one way to ask an ES module for its verdict
 * (tests/invariants/helpers/esm-export.ts) answers with the value the module
 * gives, whatever the export's kind.
 *
 * WHY. The helper first called the export and serialised what came back.
 * An async export came back as a Promise, which `JSON.stringify` turns into
 * `{}`, so a spec asserting `problems ?? []` on it passed with status 0 and
 * no verdict at all. A constant export could not be read through it, so a
 * spec that needed eslint.config.mjs's constants kept a private
 * `node --input-type=module -e` shim beside the helper (G041-G042 review,
 * INFRA-LOW-229 class).
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from '@jest/globals';

import { removeFixtureTree } from '../../tools/gates/fixture-tree';
import { callEsmExport, esmExportResult } from './helpers/esm-export';

const FIXTURE_DIR = mkdtempSync(join(tmpdir(), 'esm-export-helper-'));
const FIXTURE = join(FIXTURE_DIR, 'fixture.mjs');
writeFileSync(
  FIXTURE,
  [
    'export const LIMIT = 30;',
    "export const NAMES = ['a', 'b'];",
    'export function plusOne(value) { return value + 1; }',
    'export async function laterPlusOne(value) { return value + 1; }',
    "export async function laterRefuses() { throw new Error('refused later'); }",
  ].join('\n'),
);

afterAll(() => {
  removeFixtureTree(FIXTURE_DIR);
});

describe('helpers/esm-export answers with the module value', () => {
  it('returns a function export result', () => {
    expect(esmExportResult<number>(FIXTURE, 'plusOne', [1])).toBe(2);
  });

  it('awaits an async export instead of serialising its Promise', () => {
    expect(esmExportResult<number>(FIXTURE, 'laterPlusOne', [1])).toBe(2);
  });

  it('reports an async export that rejects as a failed call', () => {
    const outcome = callEsmExport(FIXTURE, 'laterRefuses', []);
    expect(outcome.status).not.toBe(0);
    expect(outcome.stderr).toContain('refused later');
  });

  it('reads a constant export', () => {
    expect(esmExportResult<number>(FIXTURE, 'LIMIT', [])).toBe(30);
    expect(esmExportResult<string[]>(FIXTURE, 'NAMES', [])).toEqual(['a', 'b']);
  });

  it('refuses arguments for a constant and a name the module does not export', () => {
    expect(callEsmExport(FIXTURE, 'LIMIT', [1]).stderr).toContain(
      'LIMIT is not a function; it takes no arguments',
    );
    expect(callEsmExport(FIXTURE, 'missing', []).stderr).toContain('exports no missing');
  });
});
