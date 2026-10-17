#!/usr/bin/env ts-node
/**
 * finding-registry accountability — ARIA-HIGH-044.
 *
 * An unresolved CRITICAL with no deadline is out of reach of every governance
 * timer: `planSweep` exempts CRITICALs from staleness, and its past-deadline
 * BLOCKED branch never fires without a deadline. The add path accepted such a
 * stub, so three ARIA CRITICALs were registered that way and sat outside the
 * lifecycle. What this spec pins:
 *
 *   - the row contract (findings.jsonl.schema.json `$defs/accountable`) refuses
 *     an unresolved CRITICAL without a non-blank `owner_user` and a `deadline`,
 *     and leaves RESOLVED and non-CRITICAL rows alone;
 *   - `add` and `add-explicit` refuse such a stub before anything is written;
 *   - every registry write validates the rows it changes (the sink), so a
 *     mutator other than `add` cannot write one either, while an untouched
 *     legacy row never blocks an unrelated write;
 *   - `assign` is the one governed way to give a legacy row its owner and
 *     deadline: it fills, never overwrites, records a reason, refuses a
 *     deadline the sweep would already call lapsed, and keeps the chain valid.
 */

import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';

import {
  appendAllocatedFinding,
  appendExplicitFinding,
  assignFinding,
  type Finding,
  validateRegistrySuffixForRechain,
  writeRegistry,
} from './finding-registry';
import { applyAssignment } from './finding-registry-assign';
import {
  rechain,
  serializeRegistryJsonl,
  verify,
  parseRegistryJsonl,
  ZERO_HASH,
} from './finding-registry-chain';
import { changedRows, RegistryWriteRefused } from './finding-registry-rows';
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
const NOW = new Date('2026-10-17T09:00:00Z');

const fixtureRoot = mkdtempSync(join(tmpdir(), 'finding-registry-accountability-spec-'));
void after(() => {
  removeFixtureTree(fixtureRoot);
});

function row(overrides: Partial<Finding>): Finding {
  return {
    id: 'ARIA-CRITICAL-901',
    severity: 'CRITICAL',
    state: 'OPEN',
    title: 'Accountability fixture finding title',
    evidence: ['tools/gates/finding-registry-accountability.spec.ts:1'],
    rule_violated: 'CLAUDE.md tracked debt',
    owner_agent: 'claude',
    raised_in_cycle: '2026-10-17-accountability',
    review_file: 'docs/reviews/claude/accountability.md',
    created_at: '2026-10-17T00:00:00Z',
    closed_at: null,
    closing_commits: [],
    deadline: '2026-10-31',
    owner_user: 'okan',
    override_of: null,
    notes: '',
    prev_hash: ZERO_HASH,
    content_hash: ZERO_HASH,
    ...overrides,
  };
}

/** A chain-valid registry file holding exactly `rows` (bypasses every writer). */
function seedRegistry(name: string, rows: Finding[]): string {
  const registryPath = join(fixtureRoot, `${name}.jsonl`);
  const entries = rows.map((entry) => ({ ...entry }));
  rechain(entries, 0);
  assert.equal(verify(entries).ok, true);
  writeFileSync(registryPath, serializeRegistryJsonl(entries), 'utf8');
  return registryPath;
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

void test('the row contract refuses an unresolved CRITICAL without an accountable owner and deadline', () => {
  // The row contract's own reader (schema + evidence shape), on one row.
  const violations = (entry: Finding): string[] =>
    validateRegistrySuffixForRechain([entry], 0, SCHEMA_PATH);

  assert.deepEqual(violations(row({})), []);
  for (const state of ['OPEN', 'IN-PROGRESS', 'STALE', 'BLOCKED'] as const) {
    for (const missing of [
      { owner_user: null },
      { deadline: null },
      { owner_user: '' },
      { owner_user: ' okan' },
      { owner_user: null, deadline: null },
    ]) {
      assert.notDeepEqual(
        violations(row({ state, ...missing })),
        [],
        `${state} CRITICAL with ${JSON.stringify(missing)} must be refused`,
      );
    }
  }
  // A resolved CRITICAL owes nothing; a HIGH keeps its 30-day STALE timer.
  assert.deepEqual(
    violations(
      row({
        state: 'RESOLVED',
        owner_user: null,
        deadline: null,
        closed_at: '2026-10-17T00:00:00Z',
        closing_commits: ['0a8f4887f'],
      }),
    ),
    [],
  );
  assert.deepEqual(
    violations(row({ id: 'ARIA-HIGH-901', severity: 'HIGH', owner_user: null, deadline: null })),
    [],
  );
});

void test('add and add-explicit refuse an ownerless open CRITICAL and write nothing', () => {
  const registryPath = seedRegistry('add-refusal', [
    row({ id: 'ARIA-HIGH-900', severity: 'HIGH' }),
  ]);
  const before = readFileSync(registryPath, 'utf8');
  const paths = { registryPath, schemaPath: SCHEMA_PATH };

  const ownerless = writeStub('ownerless', stubFields({ owner_user: null, deadline: null }));
  const allocated = withRegistryFileLock(registryPath, (lease) =>
    appendAllocatedFinding('ARIA', ownerless, lease, paths),
  );
  assert.equal(allocated, 1);
  assert.equal(readFileSync(registryPath, 'utf8'), before);

  const undated = writeStub(
    'undated-explicit',
    stubFields({ id: 'ARIA-CRITICAL-902', deadline: null }),
  );
  const explicit = withRegistryFileLock(registryPath, (lease) =>
    appendExplicitFinding(undated, lease, paths),
  );
  assert.equal(explicit, 1);
  assert.equal(readFileSync(registryPath, 'utf8'), before);

  const accountable = writeStub('accountable', stubFields());
  const added = withRegistryFileLock(registryPath, (lease) =>
    appendAllocatedFinding('ARIA', accountable, lease, paths),
  );
  assert.equal(added, 0);
  assert.match(readFileSync(registryPath, 'utf8'), /"id":"ARIA-CRITICAL-901"/);
});

void test('changedRows ignores hash-only differences and names new or edited rows', () => {
  const previous = [row({ id: 'ARIA-HIGH-900', severity: 'HIGH' }), row({})];
  rechain(previous, 0);
  const rehashed = previous.map((entry) => ({ ...entry, prev_hash: '1'.repeat(64) }));
  assert.deepEqual(changedRows(previous, rehashed), []);

  const edited = previous.map((entry) =>
    entry.id === 'ARIA-HIGH-900' ? { ...entry, state: 'STALE' as const } : entry,
  );
  const added = [...previous, row({ id: 'ARIA-CRITICAL-903' })];
  assert.deepEqual(
    changedRows(previous, edited).map((entry) => entry.id),
    ['ARIA-HIGH-900'],
  );
  assert.deepEqual(
    changedRows(previous, added).map((entry) => entry.id),
    ['ARIA-CRITICAL-903'],
  );
});

void test('every registry write validates the rows it changes, never the untouched legacy ones', () => {
  // A legacy ownerless open CRITICAL, written before the rule existed.
  const legacy = row({ id: 'ARIA-CRITICAL-904', owner_user: null, deadline: null });
  const registryPath = seedRegistry('sink', [
    row({ id: 'ARIA-HIGH-900', severity: 'HIGH' }),
    legacy,
  ]);
  const paths = { registryPath, schemaPath: SCHEMA_PATH };

  // An unrelated mutation still writes: the legacy row is not this write's.
  const unrelated = parseRegistryJsonl(readFileSync(registryPath, 'utf8')).map((entry) =>
    entry.id === 'ARIA-HIGH-900' ? { ...entry, state: 'STALE' as const } : entry,
  );
  rechain(unrelated, 0);
  withRegistryFileLock(registryPath, (lease) => writeRegistry(unrelated, lease, paths));
  assert.match(readFileSync(registryPath, 'utf8'), /"id":"ARIA-HIGH-900"[^\n]*"state":"STALE"/);

  // A sweep-style transition of the legacy row itself is refused, whole.
  const before = readFileSync(registryPath, 'utf8');
  const blocked = parseRegistryJsonl(before).map((entry) =>
    entry.id === 'ARIA-CRITICAL-904' ? { ...entry, state: 'BLOCKED' as const } : entry,
  );
  rechain(blocked, 0);
  assert.throws(
    () => withRegistryFileLock(registryPath, (lease) => writeRegistry(blocked, lease, paths)),
    (error: unknown) =>
      error instanceof RegistryWriteRefused &&
      error.violations.some((line) => line.startsWith('ARIA-CRITICAL-904')) &&
      /finding-registry assign/.test(error.message),
  );
  assert.equal(readFileSync(registryPath, 'utf8'), before);
});

void test('applyAssignment fills missing accountability and refuses everything else', () => {
  const ownerless = (): Finding => row({ owner_user: null, deadline: null, notes: 'n' });
  const reason = 'ARIA-HIGH-044 legacy row';

  const filled = ownerless();
  const outcome = applyAssignment(filled, {
    ownerUser: 'okan',
    deadline: '2026-10-31',
    reason,
    now: NOW,
  });
  assert.deepEqual(outcome, { ok: true, changed: true, fields: ['owner_user', 'deadline'] });
  assert.equal(filled.owner_user, 'okan');
  assert.equal(filled.deadline, '2026-10-31');
  assert.equal(
    filled.notes,
    `n [assign 2026-10-17: owner_user=okan, deadline=2026-10-31 — ${reason}]`,
  );

  // Same value again: a no-op that touches nothing, notes included.
  const again = applyAssignment(filled, { ownerUser: 'okan', reason, now: NOW });
  assert.deepEqual(again, { ok: true, changed: false, fields: [] });
  assert.equal(filled.notes?.match(/\[assign /g)?.length, 1);

  const refusals: [string, Parameters<typeof applyAssignment>[1], Finding][] = [
    ['no field', { reason, now: NOW }, ownerless()],
    ['empty reason', { ownerUser: 'okan', reason: '  ', now: NOW }, ownerless()],
    ['overwrite owner', { ownerUser: 'someone', reason, now: NOW }, row({})],
    ['re-date deadline', { deadline: '2026-11-30', reason, now: NOW }, row({})],
    // The sweep calls a calendar date lapsed from the start of its UTC day.
    ['lapsed deadline', { deadline: '2026-10-17', reason, now: NOW }, ownerless()],
    ['unparseable deadline', { deadline: 'next week', reason, now: NOW }, ownerless()],
  ];
  for (const [label, request, entry] of refusals) {
    const before = JSON.stringify(entry);
    const refused = applyAssignment(entry, request);
    assert.equal(refused.ok, false, label);
    assert.equal(JSON.stringify(entry), before, `${label} must not mutate the row`);
  }

  // Any state, RESOLVED included: a reopen of an ownerless RESOLVED CRITICAL
  // needs an owner first, and assign is how it gets one.
  const resolved = row({
    state: 'RESOLVED',
    owner_user: null,
    deadline: null,
    closed_at: '2026-10-17T00:00:00Z',
    closing_commits: ['0a8f4887f'],
  });
  assert.equal(applyAssignment(resolved, { ownerUser: 'okan', reason, now: NOW }).ok, true);
});

void test('assign gives a legacy row its owner and deadline and keeps the chain valid', () => {
  const registryPath = seedRegistry('assign', [
    row({ id: 'ARIA-CRITICAL-905', owner_user: null, deadline: null }),
    row({ id: 'ARIA-HIGH-900', severity: 'HIGH' }),
  ]);
  const paths = { registryPath, schemaPath: SCHEMA_PATH };
  const request = {
    ownerUser: 'okan',
    deadline: '2026-10-31',
    reason: 'ARIA-HIGH-044 legacy row',
    now: NOW,
  };

  const exit = withRegistryFileLock(registryPath, (lease) =>
    assignFinding('ARIA-CRITICAL-905', request, lease, paths),
  );
  assert.equal(exit, 0);
  const entries = parseRegistryJsonl(readFileSync(registryPath, 'utf8'));
  assert.equal(verify(entries).ok, true);
  const assigned = entries.find((entry) => entry.id === 'ARIA-CRITICAL-905');
  assert.equal(assigned?.owner_user, 'okan');
  assert.equal(assigned?.deadline, '2026-10-31');

  const after = readFileSync(registryPath, 'utf8');
  assert.equal(
    withRegistryFileLock(registryPath, (lease) =>
      assignFinding('ARIA-CRITICAL-905', request, lease, paths),
    ),
    0,
  );
  assert.equal(readFileSync(registryPath, 'utf8'), after, 'a repeated assign is a no-op');
  assert.equal(
    withRegistryFileLock(registryPath, (lease) =>
      assignFinding('ARIA-CRITICAL-905', { ...request, ownerUser: 'someone' }, lease, paths),
    ),
    1,
  );
  assert.equal(
    withRegistryFileLock(registryPath, (lease) =>
      assignFinding('ARIA-CRITICAL-999', request, lease, paths),
    ),
    1,
  );
  assert.equal(readFileSync(registryPath, 'utf8'), after);
});
