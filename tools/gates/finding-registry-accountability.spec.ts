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
  canonicalizeOwnerSpelling,
  type Finding,
  findUnownedPastDeadline,
  planSweep,
  sweepReportLines,
  validateRegistrySuffixForRechain,
  writeRegistry,
} from './finding-registry';
import { applyAssignment } from './finding-registry-assign';
import {
  rechain,
  serializeRegistryJsonl,
  UNRESOLVED_FINDING_STATES,
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
    owner_user: 'Okan-wqm',
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
  // Every state the registry's predicate calls unresolved, so the schema's
  // `not RESOLVED` rule and isUnresolvedFindingState cannot drift apart.
  for (const state of UNRESOLVED_FINDING_STATES) {
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
    ownerUser: 'Okan-wqm',
    deadline: '2026-10-31',
    reason,
    now: NOW,
  });
  assert.deepEqual(outcome, { ok: true, changed: true, fields: ['owner_user', 'deadline'] });
  assert.equal(filled.owner_user, 'Okan-wqm');
  assert.equal(filled.deadline, '2026-10-31');
  assert.equal(
    filled.notes,
    `n [assign 2026-10-17: owner_user=Okan-wqm, deadline=2026-10-31 — ${reason}]`,
  );

  // Same value again: a no-op that touches nothing, notes included.
  const again = applyAssignment(filled, { ownerUser: 'Okan-wqm', reason, now: NOW });
  assert.deepEqual(again, { ok: true, changed: false, fields: [] });
  assert.equal(filled.notes?.match(/\[assign /g)?.length, 1);

  const refusals: [string, Parameters<typeof applyAssignment>[1], Finding][] = [
    ['no field', { reason, now: NOW }, ownerless()],
    ['empty reason', { ownerUser: 'Okan-wqm', reason: '  ', now: NOW }, ownerless()],
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
  assert.equal(applyAssignment(resolved, { ownerUser: 'Okan-wqm', reason, now: NOW }).ok, true);
});

void test('assign gives a legacy row its owner and deadline and keeps the chain valid', () => {
  const registryPath = seedRegistry('assign', [
    row({ id: 'ARIA-CRITICAL-905', owner_user: null, deadline: null }),
    row({ id: 'ARIA-HIGH-900', severity: 'HIGH' }),
  ]);
  const paths = { registryPath, schemaPath: SCHEMA_PATH };
  const request = {
    ownerUser: 'Okan-wqm',
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
  assert.equal(assigned?.owner_user, 'Okan-wqm');
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

// --- ARIA-MEDIUM-535: owner_user is a CODEOWNERS handle --------------------------------------

void test('ARIA-MEDIUM-535: add stores owner_user as its CODEOWNERS handle and refuses a non-identity', () => {
  const registryPath = seedRegistry('owner-add', [row({ id: 'ARIA-HIGH-900', severity: 'HIGH' })]);
  const paths = { registryPath, schemaPath: SCHEMA_PATH };

  const variant = writeStub(
    'owner-variant',
    stubFields({ id: 'ARIA-CRITICAL-910', owner_user: '@okan-wqm' }),
  );
  assert.equal(
    withRegistryFileLock(registryPath, (lease) => appendExplicitFinding(variant, lease, paths)),
    0,
  );
  const added = parseRegistryJsonl(readFileSync(registryPath, 'utf8')).find(
    (entry) => entry.id === 'ARIA-CRITICAL-910',
  );
  assert.equal(added?.owner_user, 'Okan-wqm');

  const before = readFileSync(registryPath, 'utf8');
  for (const [name, owner] of [
    ['owner-role', 'farm-module maintainer'],
    ['owner-first-name', 'okan'],
    ['owner-email', 'someone@example.com'],
  ] as const) {
    const stub = writeStub(name, stubFields({ id: 'ARIA-CRITICAL-911', owner_user: owner }));
    const exit = (() => {
      try {
        return withRegistryFileLock(registryPath, (lease) =>
          appendExplicitFinding(stub, lease, paths),
        );
      } catch (error) {
        assert.ok(error instanceof RegistryWriteRefused, String(error));
        return 1;
      }
    })();
    assert.notEqual(exit, 0, `${owner} is not a CODEOWNERS handle`);
    assert.equal(readFileSync(registryPath, 'utf8'), before, `${owner}: nothing written`);
  }
});

void test('ARIA-MEDIUM-535: assign stores the handle; a write that sets a non-identity owner is refused', () => {
  const registryPath = seedRegistry('owner-sink', [
    row({ id: 'ARIA-HIGH-912', severity: 'HIGH', owner_user: null }),
    row({ id: 'ARIA-HIGH-913', severity: 'HIGH', owner_user: 'by-okan@live.com' }),
  ]);
  const paths = { registryPath, schemaPath: SCHEMA_PATH };
  assert.equal(
    withRegistryFileLock(registryPath, (lease) =>
      assignFinding(
        'ARIA-HIGH-912',
        { ownerUser: '@OKAN-WQM', reason: 'ARIA-MEDIUM-535', now: NOW },
        lease,
        paths,
      ),
    ),
    0,
  );
  const entries = parseRegistryJsonl(readFileSync(registryPath, 'utf8'));
  assert.equal(entries.find((entry) => entry.id === 'ARIA-HIGH-912')?.owner_user, 'Okan-wqm');

  // A write that sets an owner no CODEOWNERS handle names is refused, whole.
  const before = readFileSync(registryPath, 'utf8');
  const renamed = parseRegistryJsonl(before).map((entry) =>
    entry.id === 'ARIA-HIGH-912' ? { ...entry, owner_user: 'someone' } : entry,
  );
  rechain(renamed, 0);
  assert.throws(
    () => withRegistryFileLock(registryPath, (lease) => writeRegistry(renamed, lease, paths)),
    (error: unknown) =>
      error instanceof RegistryWriteRefused &&
      error.violations.some((line) => line.startsWith('ARIA-HIGH-912 /owner_user')),
  );
  assert.equal(readFileSync(registryPath, 'utf8'), before);

  // A write that only carries a legacy owner (a sweep of that row) is not refused for it.
  const swept = parseRegistryJsonl(before).map((entry) =>
    entry.id === 'ARIA-HIGH-913' ? { ...entry, state: 'STALE' as const } : entry,
  );
  rechain(swept, 0);
  withRegistryFileLock(registryPath, (lease) => writeRegistry(swept, lease, paths));
  assert.match(readFileSync(registryPath, 'utf8'), /"id":"ARIA-HIGH-913"[^\n]*"state":"STALE"/);
});

void test('ARIA-MEDIUM-535: canonicalize-owner rewrites one spelling to its handle, records why, keeps the chain', () => {
  const registryPath = seedRegistry('owner-canonicalize', [
    row({ id: 'ARIA-HIGH-914', severity: 'HIGH', owner_user: 'okan', notes: 'n' }),
    row({ id: 'ARIA-HIGH-915', severity: 'HIGH', owner_user: 'Okan-Wqm' }),
    row({ id: 'ARIA-HIGH-916', severity: 'HIGH', owner_user: 'okan' }),
    row({ id: 'ARIA-HIGH-917', severity: 'HIGH', owner_user: 'by-okan@live.com' }),
  ]);
  const paths = { registryPath, schemaPath: SCHEMA_PATH };
  const run = (spelling: string, to?: string, reason = 'ARIA-MEDIUM-535'): number =>
    withRegistryFileLock(registryPath, (lease) =>
      canonicalizeOwnerSpelling({ spelling, to, reason, now: NOW }, lease, paths),
    );

  // A first name names no handle by itself: the identity must be stated.
  const untouched = readFileSync(registryPath, 'utf8');
  assert.equal(run('okan'), 1);
  assert.equal(run('okan', 'someone-else'), 1, 'the target must be a CODEOWNERS handle');
  assert.equal(run('okan', 'Okan-wqm', '  '), 1, 'a reason is required');
  assert.equal(readFileSync(registryPath, 'utf8'), untouched);

  assert.equal(run('okan', 'Okan-wqm'), 0);
  assert.equal(run('Okan-Wqm'), 0, 'a case variant of the handle resolves by itself');
  const entries = parseRegistryJsonl(readFileSync(registryPath, 'utf8'));
  assert.equal(verify(entries).ok, true);
  const owners = Object.fromEntries(entries.map((entry) => [entry.id, entry.owner_user]));
  assert.deepEqual(owners, {
    'ARIA-HIGH-914': 'Okan-wqm',
    'ARIA-HIGH-915': 'Okan-wqm',
    'ARIA-HIGH-916': 'Okan-wqm',
    'ARIA-HIGH-917': 'by-okan@live.com',
  });
  assert.equal(
    entries.find((entry) => entry.id === 'ARIA-HIGH-914')?.notes,
    'n [canonicalize-owner 2026-10-17: owner_user okan -> Okan-wqm — ARIA-MEDIUM-535]',
  );

  // Nothing left to rewrite: a no-op that writes nothing.
  const after = readFileSync(registryPath, 'utf8');
  assert.equal(run('okan', 'Okan-wqm'), 0);
  assert.equal(readFileSync(registryPath, 'utf8'), after);
});

// --- ARIA-MEDIUM-601: a BLOCKED row is accountable; the sweep never writes an ownerless one ---

void test('ARIA-MEDIUM-601: the row contract refuses a BLOCKED row without an accountable owner, at any severity', () => {
  const violations = (entry: Finding): string[] =>
    validateRegistrySuffixForRechain([entry], 0, SCHEMA_PATH);
  for (const severity of ['HIGH', 'MEDIUM', 'LOW'] as const) {
    const id = `ARIA-${severity}-920`;
    assert.deepEqual(violations(row({ id, severity, state: 'BLOCKED' })), []);
    for (const missing of [
      { owner_user: null },
      { owner_user: '' },
      { owner_user: '   ' },
      { deadline: null },
    ]) {
      assert.notDeepEqual(
        violations(row({ id, severity, state: 'BLOCKED', ...missing })),
        [],
        `BLOCKED ${severity} with ${JSON.stringify(missing)} must be refused`,
      );
    }
  }
  // The rule is BLOCKED's, not every unresolved row's: an ownerless OPEN HIGH stays valid.
  assert.deepEqual(
    violations(row({ id: 'ARIA-HIGH-921', severity: 'HIGH', owner_user: null, deadline: null })),
    [],
  );
});

void test('ARIA-MEDIUM-601: the sweep reports a lapsed ownerless row UNOWNED and plans no transition for it', () => {
  const lapsed = '2026-10-01';
  const long_ago = '2026-01-01T00:00:00Z';
  const entries = [
    row({ id: 'ARIA-HIGH-930', severity: 'HIGH', owner_user: null, deadline: lapsed }),
    // Ownerless, lapsed AND older than the STALE threshold: no STALE fall-through either.
    row({
      id: 'ARIA-MEDIUM-931',
      severity: 'MEDIUM',
      owner_user: '  ',
      deadline: lapsed,
      created_at: long_ago,
    }),
    row({ id: 'ARIA-HIGH-932', severity: 'HIGH', deadline: lapsed }),
    row({ id: 'ARIA-HIGH-933', severity: 'HIGH', owner_user: null, deadline: '2026-12-01' }),
    row({
      id: 'ARIA-HIGH-934',
      severity: 'HIGH',
      owner_user: null,
      deadline: lapsed,
      state: 'RESOLVED',
      closed_at: '2026-10-02T00:00:00Z',
      closing_commits: ['0a8f4887f'],
    }),
  ];
  const actions = planSweep(entries, { staleAfterDays: 30, dryRun: true, now: NOW });
  assert.deepEqual(
    actions.map((action) => [action.id, action.toState]),
    [['ARIA-HIGH-932', 'BLOCKED']],
    'only the owned lapsed row is blocked',
  );
  assert.deepEqual(
    findUnownedPastDeadline(entries, NOW).map((entry) => entry.id),
    ['ARIA-HIGH-930', 'ARIA-MEDIUM-931'],
  );
});

void test('ARIA-MEDIUM-601: the sweep report keeps its first line and lists UNOWNED rows after it', () => {
  const unowned = [
    row({ id: 'ARIA-HIGH-940', severity: 'HIGH', owner_user: null, deadline: '2026-10-01' }),
  ];
  const hint = 'finding-registry assign ARIA-HIGH-940 --owner-user=<handle>';
  // Clean: the workflow greps ^Sweep clean: on the first line to decide has_changes.
  assert.deepEqual(sweepReportLines({ scanned: 3, actions: [], unowned }), [
    'Sweep clean: 0 transitions needed (3 entries scanned).',
    `  UNOWNED ARIA-HIGH-940 past deadline 2026-10-01 (${hint})`,
  ]);
  assert.deepEqual(sweepReportLines({ scanned: 3, actions: [], unowned: [] }), [
    'Sweep clean: 0 transitions needed (3 entries scanned).',
  ]);
  const action = {
    id: 'ARIA-HIGH-941',
    fromState: 'OPEN' as const,
    toState: 'BLOCKED' as const,
    reason: 'past deadline 2026-10-01',
  };
  assert.deepEqual(sweepReportLines({ scanned: 3, actions: [action], unowned }), [
    'Sweep plan (1 transitions):',
    `  UNOWNED ARIA-HIGH-940 past deadline 2026-10-01 (${hint})`,
    '  ARIA-HIGH-941: OPEN → BLOCKED  (past deadline 2026-10-01)',
  ]);
});

// SE-3-R2 corrective round 1, root R5 (build/SE-3-R2/appellate-r1.md): four rows were appended
// with a created_at about 9 h after the commit that added them. The staleness sweep and dedup
// read created_at, and the chain seals it on merge, so a row whose created_at lies after the
// write that records it is refused by the write sink, for every writer.
void test('R5: a write that records a row created after the write itself is refused, whole', () => {
  const registryPath = seedRegistry('future', [row({ id: 'ARIA-HIGH-905', severity: 'HIGH' })]);
  const paths = { registryPath, schemaPath: SCHEMA_PATH };
  const before = readFileSync(registryPath, 'utf8');
  const future = [
    ...parseRegistryJsonl(before),
    row({ id: 'ARIA-HIGH-906', severity: 'HIGH', created_at: '2999-01-01T00:00:00Z' }),
  ];
  rechain(future, 0);
  assert.throws(
    () => withRegistryFileLock(registryPath, (lease) => writeRegistry(future, lease, paths)),
    (error: unknown) =>
      error instanceof RegistryWriteRefused &&
      error.violations.some(
        (line) => line.startsWith('ARIA-HIGH-906') && /created_at .* is after/.test(line),
      ),
  );
  assert.equal(readFileSync(registryPath, 'utf8'), before);

  // A stub that dates its row in the future is refused by add, and nothing is written.
  const stubPath = writeStub(
    'future-stub',
    stubFields({ severity: 'HIGH', created_at: '2999-01-01T00:00:00Z' }),
  );
  const status = withRegistryFileLock(registryPath, (lease) =>
    appendAllocatedFinding('ARIA', stubPath, lease, paths),
  );
  assert.notEqual(status, 0);
  assert.equal(readFileSync(registryPath, 'utf8'), before);
});
