import {
  type FindingEvent,
  FindingEventReplayError,
  computeFindingEventHash,
  replayFindingEvents,
  replayFindingProjection,
} from './finding-event';

const ZERO_HASH = '0'.repeat(64);

function event(
  overrides: Partial<FindingEvent> & Pick<FindingEvent, 'event_type' | 'payload'>,
): FindingEvent {
  const candidate: FindingEvent = {
    event_id: overrides.event_id ?? '11111111-1111-4111-8111-111111111111',
    finding_id: overrides.finding_id ?? 'DATA-HIGH-009',
    version: overrides.version ?? 1,
    event_type: overrides.event_type,
    payload: overrides.payload,
    main_sha: overrides.main_sha ?? 'a'.repeat(40),
    occurred_at: overrides.occurred_at ?? '2026-07-17T00:00:00.000Z',
    prev_hash: overrides.prev_hash ?? ZERO_HASH,
    content_hash: '',
  };
  return { ...candidate, content_hash: computeFindingEventHash(candidate) };
}

describe('FindingEvent replay', () => {
  it('folds immutable events without changing finding identity', () => {
    const created = event({
      event_type: 'CREATED',
      payload: {
        severity: 'HIGH',
        state: 'OPEN',
        title: 'Ledger gap',
        layer: 3,
        owner_agent: 'data-expert',
        raised_in_cycle: 'cycle-1',
        review_file: 'docs/reviews/orphan-findings.md',
        evidence: [],
        rule_violated: 'Immutable history required',
        notes: '',
        narrative: ['Full audit context'],
        deadline: '2026-07-22',
        owner_user: null,
        override_of: null,
        closing_commits: [],
        created_at: '2026-07-17T00:00:00Z',
        closed_at: null,
      },
    });
    const evidence = event({
      event_id: '22222222-2222-4222-8222-222222222222',
      version: 2,
      prev_hash: created.content_hash,
      event_type: 'EVIDENCE_ADDED',
      payload: { evidence: ['tests/invariants/finding-event-ledger.spec.ts'] },
    });
    const transitioned = event({
      event_id: '33333333-3333-4333-8333-333333333333',
      version: 3,
      prev_hash: evidence.content_hash,
      event_type: 'STATE_TRANSITIONED',
      payload: {
        from_state: 'OPEN',
        to_state: 'RESOLVED',
        closing_commit: 'b'.repeat(40),
        closed_at: '2026-07-17T03:00:00Z',
      },
    });

    const result = replayFindingEvents([created, evidence, transitioned]);
    const projection = result.findings.get('DATA-HIGH-009');

    expect(result.chain_tip).toBe(transitioned.content_hash);
    expect(projection).toMatchObject({
      finding_id: 'DATA-HIGH-009',
      version: 3,
      state: 'RESOLVED',
      evidence: ['tests/invariants/finding-event-ledger.spec.ts'],
      closing_commits: ['b'.repeat(40)],
      narrative: ['Full audit context'],
    });
  });

  it('rejects a per-finding version gap before projecting state', () => {
    const created = event({
      event_type: 'CREATED',
      payload: {
        severity: 'HIGH',
        state: 'OPEN',
        title: 'Ledger gap',
        layer: 3,
        owner_agent: 'data-expert',
        raised_in_cycle: 'cycle-1',
        review_file: null,
        evidence: [],
        rule_violated: null,
        notes: null,
        narrative: [],
        deadline: null,
        owner_user: null,
        override_of: null,
        closing_commits: [],
        created_at: '2026-07-17T00:00:00Z',
        closed_at: null,
      },
    });
    const gap = event({
      event_id: '44444444-4444-4444-8444-444444444444',
      version: 3,
      prev_hash: created.content_hash,
      event_type: 'OWNER_ASSIGNED',
      payload: { owner_agent: 'context-manager', owner_user: null },
    });

    try {
      replayFindingEvents([created, gap]);
      throw new Error('expected replay to reject a version gap');
    } catch (error) {
      expect(error).toBeInstanceOf(FindingEventReplayError);
      expect((error as FindingEventReplayError).eventIndex).toBe(1);
    }
  });

  it('rejects content-hash tampering', () => {
    const created = event({
      event_type: 'CREATED',
      payload: {
        severity: 'HIGH',
        state: 'OPEN',
        title: 'Ledger gap',
        layer: 3,
        owner_agent: 'data-expert',
        raised_in_cycle: 'cycle-1',
        review_file: null,
        evidence: [],
        rule_violated: null,
        notes: null,
        narrative: [],
        deadline: null,
        owner_user: null,
        override_of: null,
        closing_commits: [],
        created_at: '2026-07-17T00:00:00Z',
        closed_at: null,
      },
    });

    expect(() => replayFindingEvents([{ ...created, content_hash: 'f'.repeat(64) }])).toThrow(
      'content hash mismatch',
    );
  });

  it('projects one finding in O(finding history) while preserving global hashes', () => {
    const created = event({
      event_type: 'CREATED',
      payload: {
        severity: 'HIGH',
        state: 'OPEN',
        title: 'Ledger gap',
        layer: 3,
        owner_agent: 'data-expert',
        raised_in_cycle: 'cycle-1',
        review_file: null,
        evidence: [],
        rule_violated: null,
        notes: null,
        narrative: [],
        deadline: null,
        owner_user: null,
        override_of: null,
        closing_commits: [],
        created_at: '2026-07-17T00:00:00Z',
        closed_at: null,
      },
    });
    const otherFinding = event({
      event_id: '55555555-5555-4555-8555-555555555555',
      finding_id: 'DATA-HIGH-010',
      prev_hash: created.content_hash,
      event_type: 'CREATED',
      payload: {
        severity: 'HIGH',
        state: 'OPEN',
        title: 'Other finding',
        layer: 3,
        owner_agent: 'data-expert',
        raised_in_cycle: 'cycle-1',
        review_file: null,
        evidence: [],
        rule_violated: null,
        notes: null,
        narrative: [],
        deadline: null,
        owner_user: null,
        override_of: null,
        closing_commits: [],
        created_at: '2026-07-17T00:00:00Z',
        closed_at: null,
      },
    });
    const evidence = event({
      event_id: '66666666-6666-4666-8666-666666666666',
      version: 2,
      prev_hash: otherFinding.content_hash,
      event_type: 'EVIDENCE_ADDED',
      payload: { evidence: ['proof'] },
    });

    expect(replayFindingEvents([created, otherFinding, evidence]).findings.size).toBe(2);
    expect(replayFindingProjection([created, evidence])).toMatchObject({
      finding_id: 'DATA-HIGH-009',
      version: 2,
      evidence: ['proof'],
    });
  });

  it('rejects non-exact payloads and transitions from terminal state', () => {
    const created = event({
      event_type: 'CREATED',
      payload: {
        severity: 'HIGH',
        state: 'RESOLVED',
        title: 'Terminal finding',
        layer: 5,
        owner_agent: 'data-expert',
        raised_in_cycle: 'cycle-1',
        review_file: null,
        evidence: ['proof'],
        rule_violated: null,
        notes: null,
        narrative: [],
        deadline: null,
        owner_user: null,
        override_of: null,
        closing_commits: ['a'.repeat(40)],
        created_at: '2026-07-17T00:00:00Z',
        closed_at: '2026-07-17T01:00:00Z',
      },
    });
    const transition = event({
      event_id: '77777777-7777-4777-8777-777777777777',
      version: 2,
      prev_hash: created.content_hash,
      event_type: 'STATE_TRANSITIONED',
      payload: {
        from_state: 'RESOLVED',
        to_state: 'IN-PROGRESS',
        closing_commit: null,
        closed_at: null,
      },
    });

    expect(() => replayFindingEvents([created, transition])).toThrow('is terminal');
    const ungoverned = JSON.parse(JSON.stringify(created)) as FindingEvent;
    Object.assign(ungoverned.payload, { ungoverned: true });
    ungoverned.content_hash = computeFindingEventHash(ungoverned);
    expect(() => replayFindingEvents([ungoverned])).toThrow('payload keys must be exactly');
  });
});
