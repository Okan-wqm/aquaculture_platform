#!/usr/bin/env ts-node
/**
 * finding-registry truth-table row — INFRA-MEDIUM-255.
 *
 * The enterprise-grade debt plan keeps exactly one truth-table row (owner,
 * first sprint, bucket) per active CRITICAL, and two invariants fail every PR
 * while a CRITICAL has none. The registration commits of the Suderra OS
 * integration audit appended nine CRITICALs to the registry and no row, so the
 * invariants ran red. Registration is the one moment a CRITICAL appears, so the
 * row is written there. What this spec pins:
 *
 *   - `addTruthTableRow` extends the active table with the row, aligned to the
 *     table's own layout, re-pads every row when a cell is wider than its
 *     column, touches nothing else, and refuses an id that already has a row or
 *     a table that has no active table;
 *   - `add` and `add-explicit` of an active CRITICAL write the registry row and
 *     the truth-table row together, and the plan contract is satisfied
 *     afterwards;
 *   - a RESOLVED CRITICAL, a CRITICAL of another state class and any other
 *     severity add no row;
 *   - a table that cannot take the row (missing, or the id already in it)
 *     refuses the add with nothing written to either file.
 */

import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';

import {
  addTruthTableRow,
  checkDebtPlanTruth,
  deriveRegistrySnapshot,
  truthTableActiveRows,
} from './debt-plan-truth';
import { appendAllocatedFinding, appendExplicitFinding, type Finding } from './finding-registry';
import { rechain, serializeRegistryJsonl, verify, ZERO_HASH } from './finding-registry-chain';
import { withRegistryFileLock } from './finding-registry-store';
import { removeFixtureTree } from './fixture-tree';

const SCHEMA_PATH = resolve(
  __dirname,
  '..',
  '..',
  'docs',
  'reviews',
  '_registry',
  'findings.jsonl.schema.json',
);

const fixtureRoot = mkdtempSync(join(tmpdir(), 'finding-registry-truth-row-spec-'));
void after(() => {
  removeFixtureTree(fixtureRoot);
});

const TABLE = [
  '# Finding Truth Table',
  '',
  'Allowed truth buckets:',
  '',
  '- `real-open`',
  '',
  '| Finding               | Registry state | First sprint | Owner             | Truth bucket |',
  '| --------------------- | -------------- | ------------ | ----------------- | ------------ |',
  '| `ARIA-CRITICAL-015`   | OPEN           | Task 19      | platform-autonomy | real-open    |',
  '| `INFRA-CRITICAL-096`  | BLOCKED        | 2026-07-19   | security-reviewer | blocked      |',
  '',
  'Updated 2026-10-17: prose after the table.',
  '',
].join('\n');

function row(overrides: Partial<Finding>): Finding {
  return {
    id: 'EDGE-CRITICAL-901',
    severity: 'CRITICAL',
    state: 'OPEN',
    title: 'Truth row fixture finding title',
    evidence: ['tools/gates/finding-registry-truth-row.spec.ts:1'],
    rule_violated: 'CLAUDE.md tracked debt',
    owner_agent: 'edge-expert',
    raised_in_cycle: '2026-10-23-truth-row',
    review_file: 'docs/reviews/claude/truth-row.md',
    created_at: '2026-10-23T00:00:00Z',
    closed_at: null,
    closing_commits: [],
    deadline: '2026-11-30',
    owner_user: 'Okan-wqm',
    override_of: null,
    notes: '',
    prev_hash: ZERO_HASH,
    content_hash: ZERO_HASH,
    ...overrides,
  };
}

interface Fixture {
  readonly registryPath: string;
  readonly truthTablePath: string;
  readonly paths: { registryPath: string; schemaPath: string; truthTablePath: string };
}

/** A chain-valid registry holding `rows`, and a truth table beside it. */
function seed(name: string, rows: Finding[], table: string | null = TABLE): Fixture {
  const registryPath = join(fixtureRoot, `${name}.jsonl`);
  const truthTablePath = join(fixtureRoot, `${name}-truth-table.md`);
  const entries = rows.map((entry) => ({ ...entry }));
  rechain(entries, 0);
  assert.equal(verify(entries).ok, true);
  writeFileSync(registryPath, serializeRegistryJsonl(entries), 'utf8');
  if (table !== null) writeFileSync(truthTablePath, table, 'utf8');
  return {
    registryPath,
    truthTablePath,
    paths: { registryPath, schemaPath: SCHEMA_PATH, truthTablePath },
  };
}

function writeStub(name: string, stub: Record<string, unknown>): string {
  const stubPath = join(fixtureRoot, `${name}.json`);
  writeFileSync(stubPath, JSON.stringify(stub), 'utf8');
  return stubPath;
}

function stubFields(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const { id: _id, prev_hash: _prev, content_hash: _content, ...fields } = row({});
  return { ...fields, ...overrides };
}

const existing = [
  row({ id: 'ARIA-CRITICAL-015', owner_agent: 'platform-autonomy' }),
  row({ id: 'INFRA-CRITICAL-096', state: 'BLOCKED', owner_agent: 'security-reviewer' }),
];

void test('addTruthTableRow extends the active table in its own layout and touches nothing else', () => {
  const next = addTruthTableRow(TABLE, {
    id: 'EDGE-CRITICAL-901',
    state: 'OPEN',
    owner: 'edge-expert',
  });
  const lines = next.split('\n');
  const before = TABLE.split('\n');
  assert.equal(lines.length, before.length + 1);
  const at = lines.findIndex((line) => line.startsWith('| `EDGE-CRITICAL-901`'));
  assert.equal(
    lines[at],
    '| `EDGE-CRITICAL-901`   | OPEN           | —            | edge-expert       | real-open    |',
  );
  assert.deepEqual(
    [...lines.slice(0, at), ...lines.slice(at + 1)],
    before,
    'every other line, the prose after the table included, is unchanged',
  );
  assert.deepEqual(
    truthTableActiveRows(next).map((r) => [r.id, r.bucket]),
    [
      ['ARIA-CRITICAL-015', 'real-open'],
      ['INFRA-CRITICAL-096', 'blocked'],
      ['EDGE-CRITICAL-901', 'real-open'],
    ],
  );
});

void test('addTruthTableRow re-pads every row when a cell is wider than its column', () => {
  const owner = 'an-owner-name-wider-than-the-owner-column';
  const next = addTruthTableRow(TABLE, { id: 'EDGE-CRITICAL-902', state: 'IN-PROGRESS', owner });
  const tableLines = next.split('\n').filter((line) => line.startsWith('|'));
  assert.equal(tableLines.length, 5);
  assert.equal(new Set(tableLines.map((line) => line.length)).size, 1, 'one width for every row');
  assert.ok(tableLines.some((line) => line.includes(`| ${owner} |`)));
  assert.equal(truthTableActiveRows(next).length, 3);
});

void test('addTruthTableRow refuses an id that has a row and a table that has no active table', () => {
  assert.throws(
    () => addTruthTableRow(TABLE, { id: 'ARIA-CRITICAL-015', state: 'OPEN', owner: 'x' }),
    /already has a row/,
  );
  assert.throws(
    () =>
      addTruthTableRow('# Finding Truth Table\n\nno table\n', {
        id: 'EDGE-CRITICAL-901',
        state: 'OPEN',
        owner: 'x',
      }),
    /no `\| Finding \| \.\.\.` active table/,
  );
  assert.throws(
    () =>
      addTruthTableRow('| Finding | State |\n| --- | --- |\n| `A-CRITICAL-001` | OPEN |\n', {
        id: 'EDGE-CRITICAL-901',
        state: 'OPEN',
        owner: 'x',
      }),
    /five columns/,
  );
});

void test('add writes the registry row and the truth-table row together, and the plan contract holds', () => {
  const fx = seed('add', existing);
  const added = withRegistryFileLock(fx.registryPath, (lease) =>
    appendAllocatedFinding('EDGE', writeStub('add', stubFields()), lease, fx.paths),
  );
  assert.equal(added, 0);
  const registry = readFileSync(fx.registryPath, 'utf8');
  assert.match(registry, /"id":"EDGE-CRITICAL-001"/);
  const table = readFileSync(fx.truthTablePath, 'utf8');
  assert.match(table, /\| `EDGE-CRITICAL-001` +\| OPEN +\| — +\| edge-expert +\| real-open +\|/);
  const verdict = checkDebtPlanTruth(deriveRegistrySnapshot(registry), truthTableActiveRows(table));
  assert.deepEqual(verdict, {
    valid: true,
    missingRows: [],
    retiredRows: [],
    duplicateRows: [],
    invalidBuckets: [],
  });
});

void test('add-explicit of an active CRITICAL writes its row too', () => {
  const fx = seed('explicit', existing);
  const added = withRegistryFileLock(fx.registryPath, (lease) =>
    appendExplicitFinding(
      writeStub('explicit', stubFields({ id: 'EDGE-CRITICAL-950', state: 'IN-PROGRESS' })),
      lease,
      fx.paths,
    ),
  );
  assert.equal(added, 0);
  assert.match(
    readFileSync(fx.truthTablePath, 'utf8'),
    /\| `EDGE-CRITICAL-950` +\| IN-PROGRESS +\| — +\| edge-expert +\| real-open +\|/,
  );
});

void test('a resolved CRITICAL and every other severity add no row', () => {
  const fx = seed('no-row', existing);
  const tableBefore = readFileSync(fx.truthTablePath, 'utf8');
  const resolved = writeStub(
    'resolved',
    stubFields({
      id: 'EDGE-CRITICAL-951',
      state: 'RESOLVED',
      closed_at: '2026-10-23T00:00:00Z',
      closing_commits: ['0a8f4887f'],
    }),
  );
  const high = writeStub('high', stubFields({ severity: 'HIGH' }));
  for (const stub of [resolved, high]) {
    const done = withRegistryFileLock(fx.registryPath, (lease) =>
      stub === resolved
        ? appendExplicitFinding(stub, lease, fx.paths)
        : appendAllocatedFinding('EDGE', stub, lease, fx.paths),
    );
    assert.equal(done, 0);
  }
  assert.equal(readFileSync(fx.truthTablePath, 'utf8'), tableBefore);
});

void test('a table that cannot take the row refuses the add with nothing written', () => {
  const duplicate = seed(
    'duplicate',
    existing,
    addTruthTableRow(TABLE, { id: 'EDGE-CRITICAL-001', state: 'OPEN', owner: 'x' }),
  );
  const missing = seed('missing', existing, null);
  for (const fx of [duplicate, missing]) {
    const registryBefore = readFileSync(fx.registryPath, 'utf8');
    const refused = withRegistryFileLock(fx.registryPath, (lease) =>
      appendAllocatedFinding('EDGE', writeStub('refused', stubFields()), lease, fx.paths),
    );
    assert.equal(refused, 1);
    assert.equal(readFileSync(fx.registryPath, 'utf8'), registryBefore);
  }
  assert.equal(
    readFileSync(duplicate.truthTablePath, 'utf8').split('EDGE-CRITICAL-001').length - 1,
    1,
    'the table still holds exactly one row of the id',
  );
});

void test('a registry without a configured table is unchanged by this contract', () => {
  const fx = seed('unconfigured', existing, null);
  const added = withRegistryFileLock(fx.registryPath, (lease) =>
    appendAllocatedFinding('EDGE', writeStub('unconfigured', stubFields()), lease, {
      registryPath: fx.registryPath,
      schemaPath: SCHEMA_PATH,
    }),
  );
  assert.equal(added, 0);
});
