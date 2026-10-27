/**
 * REG-ID — the reviewed-exception library admits exactly the finding ids the
 * grammar owner admits.
 *
 * scripts/ci/lib/reviewed-exception.mjs is plain ESM that CI scripts run with
 * `node`, so it cannot import tools/gates/finding-id-grammar.ts and keeps its
 * own `finding_id` pattern. That is the one place outside the scanned roots
 * (tools/, tests/, aria-kernel/; tests/invariants/finding-id-grammar.spec.ts)
 * that spells the grammar, and like the registry row schema it is held to the
 * owner by the one table both grammar owners are held to
 * (tools/gates/fixtures/finding-id-grammar-table.json): a reviewed exception
 * naming ARIA-HIGH-1000 must not be refused while the registry issues it.
 *
 * The library is called, not read: a spec that re-typed its rule would be a
 * third copy (INFRA-LOW-229, tests/invariants/helpers/esm-export.ts).
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from '@jest/globals';

import { esmExportResult } from './helpers/esm-export';

const REPO_ROOT = resolve(__dirname, '..', '..');
const LIB = join(REPO_ROOT, 'scripts', 'ci', 'lib', 'reviewed-exception.mjs');
const TABLE = JSON.parse(
  readFileSync(
    join(REPO_ROOT, 'tools', 'gates', 'fixtures', 'finding-id-grammar-table.json'),
    'utf8',
  ),
) as { accept: ReadonlyArray<{ id: string }>; reject: readonly string[] };

/** Every `finding_id` problem the library reports for each id, the id being the entry's location. */
function findingIdProblems(ids: readonly string[]): ReadonlyMap<string, readonly string[]> {
  const entries = Object.fromEntries(
    ids.map((id) => [
      id,
      {
        owner: 'Okan-wqm',
        reason: 'a reason long enough to be an argument and not a label',
        expires_on: '2099-12-31',
        finding_id: id,
      },
    ]),
  );
  const problems = esmExportResult<string[]>(LIB, 'validateReviewedExceptions', [
    entries,
    '2026-10-25',
  ]);
  return new Map(
    ids.map((id) => [
      id,
      problems.filter((problem) => problem.startsWith(`${id}: finding_id must be`)),
    ]),
  );
}

describe('REG-ID — the reviewed-exception library and the finding-id grammar', () => {
  it('admits every tabled id', () => {
    const accepted = TABLE.accept.map((entry) => entry.id);
    const problems = findingIdProblems(accepted);
    for (const id of accepted) {
      expect({ id, problems: problems.get(id) }).toEqual({ id, problems: [] });
    }
  });

  it('refuses every refused id', () => {
    const problems = findingIdProblems(TABLE.reject);
    for (const id of TABLE.reject) {
      expect({ id, refused: (problems.get(id) ?? []).length > 0 }).toEqual({ id, refused: true });
    }
  });
});
