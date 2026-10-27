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
 *   - every registry write validates the rows it changes (the event sink,
 *     finding-registry-events.ts `appendFindingEvents`), so a mutator other
 *     than `add` cannot write one either, while an untouched legacy row never
 *     blocks an unrelated write;
 *   - `assign` is the one governed way to give a legacy row its owner and
 *     deadline: it fills, never overwrites, records its reason on the
 *     OWNER_ASSIGNED event, refuses a deadline the sweep would already call
 *     lapsed, and leaves the frozen genesis segment untouched.
 */

import { strict as assert } from 'node:assert';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
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
} from './finding-registry';
import { applyAssignment } from './finding-registry-assign';
import {
  rechain,
  serializeRegistryJsonl,
  UNRESOLVED_FINDING_STATES,
  verify,
  ZERO_HASH,
} from './finding-registry-chain';
import {
  appendFindingEvents,
  type FindingEventDraft,
  type FindingEventLine,
} from './finding-registry-events';
import {
  foldRegistry,
  readRegistryStoreIn,
  registryLayout,
  type RegistryLayout,
} from './finding-registry-projection';
import { RegistryWriteRefused, rowContractViolations } from './finding-registry-rows';
import { type RegistryLockLease, withRegistryFileLock } from './finding-registry-store';
import { removeFixtureTree } from './fixture-tree';

const REGISTRY_DIR = resolve(__dirname, '..', '..', 'docs', 'reviews', '_registry');
const SCHEMA_PATH = join(REGISTRY_DIR, 'findings.jsonl.schema.json');
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

/**
 * A registry directory whose frozen genesis segment holds exactly `rows`
 * (chain-valid; bypasses every writer), with the row and event contracts.
 */
function seedRegistry(name: string, rows: Finding[]): RegistryLayout {
  const layout = registryLayout(join(fixtureRoot, name));
  mkdirSync(layout.dir, { recursive: true });
  const entries = rows.map((entry) => ({ ...entry }));
  rechain(entries, 0);
  assert.equal(verify(entries).ok, true);
  writeFileSync(layout.genesisPath, serializeRegistryJsonl(entries), 'utf8');
  copyFileSync(SCHEMA_PATH, layout.rowSchemaPath);
  copyFileSync(join(REGISTRY_DIR, 'finding-event.schema.json'), layout.eventSchemaPath);
  return layout;
}

/** The rows as recorded: genesis and events folded. */
function recorded(layout: RegistryLayout): Map<string, Finding> {
  return new Map(foldRegistry(readRegistryStoreIn(layout.dir)).map((entry) => [entry.id, entry]));
}

/** Every byte the registry holds: the genesis segment and every event log. */
function snapshot(layout: RegistryLayout): string {
  const walk = (dir: string): string[] =>
    existsSync(dir)
      ? readdirSync(dir)
          .sort()
          .flatMap((name) => {
            const path = join(dir, name);
            return statSync(path).isDirectory() ? walk(path) : [path];
          })
      : [];
  return [layout.genesisPath, ...walk(layout.storeDir)]
    .map((path) => `${path}\n${readFileSync(path, 'utf8')}`)
    .join('\n');
}

function events(layout: RegistryLayout, id: string): FindingEventLine[] {
  return [...(readRegistryStoreIn(layout.dir).logs.get(id)?.events ?? [])];
}

function locked<T>(layout: RegistryLayout, action: (lease: RegistryLockLease) => T): T {
  return withRegistryFileLock(layout.dir, action);
}

function transitionDraft(
  id: string,
  from: Finding['state'],
  to: 'STALE' | 'BLOCKED',
): FindingEventDraft {
  return {
    finding_id: id,
    event_type: 'STATE_TRANSITIONED',
    payload: { from_state: from, to_state: to },
    actor: 'finding-registry/sweep',
    reason: `sweep: ${to}`,
    occurred_at: NOW.toISOString(),
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

/** The row contract's own reader (schema + evidence shape), on one row. */
function violations(entry: Finding): string[] {
  const found = rowContractViolations(entry, SCHEMA_PATH, 'post-cutover');
  return [...found.schema, ...found.evidence.map((item) => JSON.stringify(item))];
}

void test('the row contract refuses an unresolved CRITICAL without an accountable owner and deadline', () => {
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
  const layout = seedRegistry('add-refusal', [row({ id: 'ARIA-HIGH-900', severity: 'HIGH' })]);
  const before = snapshot(layout);

  const ownerless = writeStub('ownerless', stubFields({ owner_user: null, deadline: null }));
  const allocated = locked(layout, (lease) =>
    appendAllocatedFinding('ARIA', ownerless, lease, layout),
  );
  assert.equal(allocated, 1);
  assert.equal(snapshot(layout), before);

  const undated = writeStub(
    'undated-explicit',
    stubFields({ id: 'ARIA-CRITICAL-902', deadline: null }),
  );
  const explicit = locked(layout, (lease) => appendExplicitFinding(undated, lease, layout));
  assert.equal(explicit, 1);
  assert.equal(snapshot(layout), before);

  const accountable = writeStub('accountable', stubFields());
  const added = locked(layout, (lease) =>
    appendAllocatedFinding('ARIA', accountable, lease, layout),
  );
  assert.equal(added, 0);
  assert.equal(recorded(layout).get('ARIA-CRITICAL-901')?.state, 'OPEN');
  assert.deepEqual(
    events(layout, 'ARIA-CRITICAL-901').map((event) => event.event_type),
    ['CREATED'],
  );
});

void test('every registry write validates the rows it changes, never the untouched legacy ones', () => {
  // A legacy ownerless open CRITICAL, written before the rule existed.
  const legacy = row({ id: 'ARIA-CRITICAL-904', owner_user: null, deadline: null });
  const layout = seedRegistry('sink', [row({ id: 'ARIA-HIGH-900', severity: 'HIGH' }), legacy]);

  // An unrelated transition still writes: the legacy row is not this write's.
  locked(layout, (lease) =>
    appendFindingEvents(layout, [transitionDraft('ARIA-HIGH-900', 'OPEN', 'STALE')], lease),
  );
  assert.equal(recorded(layout).get('ARIA-HIGH-900')?.state, 'STALE');

  // A sweep-style transition of the legacy row itself is refused, whole.
  const before = snapshot(layout);
  assert.throws(
    () =>
      locked(layout, (lease) =>
        appendFindingEvents(
          layout,
          [transitionDraft('ARIA-CRITICAL-904', 'OPEN', 'BLOCKED')],
          lease,
        ),
      ),
    (error: unknown) =>
      error instanceof RegistryWriteRefused &&
      error.violations.some((line) => line.startsWith('ARIA-CRITICAL-904')) &&
      /finding-registry assign/.test(error.message),
  );
  assert.equal(snapshot(layout), before);
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

void test('assign gives a legacy row its owner and deadline as an OWNER_ASSIGNED event', () => {
  const layout = seedRegistry('assign', [
    row({ id: 'ARIA-CRITICAL-905', owner_user: null, deadline: null }),
    row({ id: 'ARIA-HIGH-900', severity: 'HIGH' }),
  ]);
  const genesis = readFileSync(layout.genesisPath, 'utf8');
  const request = {
    ownerUser: 'Okan-wqm',
    deadline: '2026-10-31',
    reason: 'ARIA-HIGH-044 legacy row',
    now: NOW,
  };

  const exit = locked(layout, (lease) =>
    assignFinding('ARIA-CRITICAL-905', request, lease, layout),
  );
  assert.equal(exit, 0);
  assert.equal(readFileSync(layout.genesisPath, 'utf8'), genesis, 'the genesis segment is frozen');
  const assigned = recorded(layout).get('ARIA-CRITICAL-905');
  assert.equal(assigned?.owner_user, 'Okan-wqm');
  assert.equal(assigned?.deadline, '2026-10-31');
  const [event, ...more] = events(layout, 'ARIA-CRITICAL-905');
  assert.deepEqual(more, []);
  assert.equal(event?.event_type, 'OWNER_ASSIGNED');
  assert.deepEqual(event?.payload, { owner_user: 'Okan-wqm', deadline: '2026-10-31' });
  assert.equal(event?.reason, 'ARIA-HIGH-044 legacy row');

  const after = snapshot(layout);
  assert.equal(
    locked(layout, (lease) => assignFinding('ARIA-CRITICAL-905', request, lease, layout)),
    0,
  );
  assert.equal(snapshot(layout), after, 'a repeated assign is a no-op');
  assert.equal(
    locked(layout, (lease) =>
      assignFinding('ARIA-CRITICAL-905', { ...request, ownerUser: 'someone' }, lease, layout),
    ),
    1,
  );
  assert.equal(
    locked(layout, (lease) => assignFinding('ARIA-CRITICAL-999', request, lease, layout)),
    1,
  );
  assert.equal(snapshot(layout), after);
});

// --- ARIA-MEDIUM-535: owner_user is a CODEOWNERS handle --------------------------------------

void test('ARIA-MEDIUM-535: add stores owner_user as its CODEOWNERS handle and refuses a non-identity', () => {
  const layout = seedRegistry('owner-add', [row({ id: 'ARIA-HIGH-900', severity: 'HIGH' })]);

  const variant = writeStub(
    'owner-variant',
    stubFields({ id: 'ARIA-CRITICAL-910', owner_user: '@okan-wqm' }),
  );
  assert.equal(
    locked(layout, (lease) => appendExplicitFinding(variant, lease, layout)),
    0,
  );
  assert.equal(recorded(layout).get('ARIA-CRITICAL-910')?.owner_user, 'Okan-wqm');

  const before = snapshot(layout);
  for (const [name, owner] of [
    ['owner-role', 'farm-module maintainer'],
    ['owner-first-name', 'okan'],
    ['owner-email', 'someone@example.com'],
  ] as const) {
    const stub = writeStub(name, stubFields({ id: 'ARIA-CRITICAL-911', owner_user: owner }));
    const exit = locked(layout, (lease) => appendExplicitFinding(stub, lease, layout));
    assert.notEqual(exit, 0, `${owner} is not a CODEOWNERS handle`);
    assert.equal(snapshot(layout), before, `${owner}: nothing written`);
  }
});

void test('ARIA-MEDIUM-535: assign stores the handle; a write that sets a non-identity owner is refused', () => {
  const layout = seedRegistry('owner-sink', [
    row({ id: 'ARIA-HIGH-912', severity: 'HIGH', owner_user: null }),
    row({ id: 'ARIA-HIGH-913', severity: 'HIGH', owner_user: 'by-okan@live.com' }),
  ]);
  assert.equal(
    locked(layout, (lease) =>
      assignFinding(
        'ARIA-HIGH-912',
        { ownerUser: '@OKAN-WQM', reason: 'ARIA-MEDIUM-535', now: NOW },
        lease,
        layout,
      ),
    ),
    0,
  );
  assert.equal(recorded(layout).get('ARIA-HIGH-912')?.owner_user, 'Okan-wqm');

  // A write that sets an owner no CODEOWNERS handle names is refused, whole.
  const before = snapshot(layout);
  const renamed: FindingEventDraft = {
    finding_id: 'ARIA-HIGH-912',
    event_type: 'AMENDED',
    payload: { fields: { owner_user: 'someone' } },
    actor: 'finding-registry/canonicalize-owner',
    reason: 'ARIA-MEDIUM-535',
    occurred_at: NOW.toISOString(),
  };
  assert.throws(
    () => locked(layout, (lease) => appendFindingEvents(layout, [renamed], lease)),
    (error: unknown) =>
      error instanceof RegistryWriteRefused &&
      error.violations.some((line) => line.startsWith('ARIA-HIGH-912 /owner_user')),
  );
  assert.equal(snapshot(layout), before);

  // A write that only carries a legacy owner (a sweep of that row) is not refused for it.
  locked(layout, (lease) =>
    appendFindingEvents(layout, [transitionDraft('ARIA-HIGH-913', 'OPEN', 'STALE')], lease),
  );
  assert.equal(recorded(layout).get('ARIA-HIGH-913')?.state, 'STALE');
});

void test('ARIA-MEDIUM-535: canonicalize-owner records one spelling as its handle, with why, as AMENDED events', () => {
  const layout = seedRegistry('owner-canonicalize', [
    row({ id: 'ARIA-HIGH-914', severity: 'HIGH', owner_user: 'okan', notes: 'n' }),
    row({ id: 'ARIA-HIGH-915', severity: 'HIGH', owner_user: 'Okan-Wqm' }),
    row({ id: 'ARIA-HIGH-916', severity: 'HIGH', owner_user: 'okan' }),
    row({ id: 'ARIA-HIGH-917', severity: 'HIGH', owner_user: 'by-okan@live.com' }),
  ]);
  const genesis = readFileSync(layout.genesisPath, 'utf8');
  const run = (spelling: string, to?: string, reason = 'ARIA-MEDIUM-535'): number =>
    locked(layout, (lease) =>
      canonicalizeOwnerSpelling({ spelling, to, reason, now: NOW }, lease, layout),
    );

  // A first name names no handle by itself: the identity must be stated.
  const untouched = snapshot(layout);
  assert.equal(run('okan'), 1);
  assert.equal(run('okan', 'someone-else'), 1, 'the target must be a CODEOWNERS handle');
  assert.equal(run('okan', 'Okan-wqm', '  '), 1, 'a reason is required');
  assert.equal(snapshot(layout), untouched);

  assert.equal(run('okan', 'Okan-wqm'), 0);
  assert.equal(run('Okan-Wqm'), 0, 'a case variant of the handle resolves by itself');
  assert.equal(readFileSync(layout.genesisPath, 'utf8'), genesis, 'the genesis segment is frozen');
  const owners = Object.fromEntries(
    [...recorded(layout).values()].map((entry) => [entry.id, entry.owner_user]),
  );
  assert.deepEqual(owners, {
    'ARIA-HIGH-914': 'Okan-wqm',
    'ARIA-HIGH-915': 'Okan-wqm',
    'ARIA-HIGH-916': 'Okan-wqm',
    'ARIA-HIGH-917': 'by-okan@live.com',
  });
  const [amended] = events(layout, 'ARIA-HIGH-914');
  assert.equal(amended?.event_type, 'AMENDED');
  assert.deepEqual(amended?.payload, { fields: { owner_user: 'Okan-wqm' } });
  assert.equal(amended?.reason, 'ARIA-MEDIUM-535');

  // Nothing left to rewrite: a no-op that writes nothing.
  const after = snapshot(layout);
  assert.equal(run('okan', 'Okan-wqm'), 0);
  assert.equal(snapshot(layout), after);
});

// --- ARIA-MEDIUM-601: a BLOCKED row is accountable; the sweep never writes an ownerless one ---

void test('ARIA-MEDIUM-601: the row contract refuses a BLOCKED row without an accountable owner, at any severity', () => {
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
  const layout = seedRegistry('future', [row({ id: 'ARIA-HIGH-905', severity: 'HIGH' })]);
  const before = snapshot(layout);
  const {
    prev_hash: _prev,
    content_hash: _content,
    ...future
  } = row({
    id: 'ARIA-HIGH-906',
    severity: 'HIGH',
    created_at: '2999-01-01T00:00:00Z',
  });
  const created: FindingEventDraft = {
    finding_id: 'ARIA-HIGH-906',
    event_type: 'CREATED',
    payload: {
      ...future,
      id: 'ARIA-HIGH-906',
      state: 'OPEN',
      closed_at: null,
      closing_commits: [],
    },
    actor: 'finding-registry/add',
    reason: null,
    occurred_at: NOW.toISOString(),
  };
  assert.throws(
    () => locked(layout, (lease) => appendFindingEvents(layout, [created], lease)),
    (error: unknown) =>
      error instanceof RegistryWriteRefused &&
      error.violations.some(
        (line) => line.startsWith('ARIA-HIGH-906') && /created_at .* is after/.test(line),
      ),
  );
  assert.equal(snapshot(layout), before);

  // A stub that dates its row in the future is refused by add, and nothing is written.
  const stubPath = writeStub(
    'future-stub',
    stubFields({ severity: 'HIGH', created_at: '2999-01-01T00:00:00Z' }),
  );
  const status = locked(layout, (lease) => appendAllocatedFinding('ARIA', stubPath, lease, layout));
  assert.notEqual(status, 0);
  assert.equal(snapshot(layout), before);
});
