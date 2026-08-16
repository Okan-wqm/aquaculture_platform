import { createHash } from 'node:crypto';

export const FINDING_EVENT_TYPES = [
  'CREATED',
  'EVIDENCE_ADDED',
  'OWNER_ASSIGNED',
  'STATE_TRANSITIONED',
  'SUPERSEDED',
] as const;

export type FindingEventType = (typeof FINDING_EVENT_TYPES)[number];
export type FindingSeverity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
export type FindingState = 'OPEN' | 'IN-PROGRESS' | 'RESOLVED' | 'STALE' | 'BLOCKED';

export const FINDING_EVENT_APPEND_LOCK_NAMESPACE = 'event_store.finding_events.append';

export interface FindingCreatedPayload {
  severity: FindingSeverity;
  state: FindingState;
  title: string;
  layer: 1 | 2 | 3 | 4 | 5 | null;
  owner_agent: string;
  raised_in_cycle: string;
  review_file: string | null;
  evidence: string[];
  rule_violated: string | null;
  notes: string | null;
  narrative: string[];
  deadline: string | null;
  owner_user: string | null;
  override_of: string | null;
  closing_commits: string[];
  created_at: string;
  closed_at: string | null;
}

export interface FindingEventPayloadMap {
  CREATED: FindingCreatedPayload;
  EVIDENCE_ADDED: { evidence: string[] };
  OWNER_ASSIGNED: { owner_agent: string; owner_user: string | null };
  STATE_TRANSITIONED: {
    from_state: FindingState;
    to_state: FindingState;
    closing_commit: string | null;
    closed_at: string | null;
  };
  SUPERSEDED: {
    successor_finding_id: string;
    adr_evidence: string;
    closed_at: string;
  };
}

export interface FindingEvent<T extends FindingEventType = FindingEventType> {
  event_id: string;
  finding_id: string;
  version: number;
  event_type: T;
  payload: FindingEventPayloadMap[T];
  main_sha: string;
  occurred_at: string;
  prev_hash: string;
  content_hash: string;
}

export interface FindingProjection extends FindingCreatedPayload {
  finding_id: string;
  version: number;
  superseded_by: string | null;
  last_event_id: string;
  last_main_sha: string;
  last_occurred_at: string;
}

export interface FindingReplayResult {
  findings: Map<string, FindingProjection>;
  chain_tip: string;
}

export const FINDING_EVENT_ZERO_HASH = '0'.repeat(64);

export class FindingEventReplayError extends Error {
  constructor(
    message: string,
    public readonly eventIndex: number | null = null,
  ) {
    super(message);
    this.name = FindingEventReplayError.name;
  }
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

export function computeFindingEventHash(event: FindingEvent): string {
  const { content_hash: _contentHash, ...hashInput } = event;
  return createHash('sha256').update(canonicalJson(hashInput), 'utf8').digest('hex');
}

export function replayFindingEvents(events: readonly FindingEvent[]): FindingReplayResult {
  const findings = new Map<string, FindingProjection>();
  let expectedPrevHash = FINDING_EVENT_ZERO_HASH;

  for (const [eventIndex, event] of events.entries()) {
    try {
      expectedPrevHash = applyGlobalFindingEvent(findings, event, expectedPrevHash);
    } catch (error) {
      if (error instanceof FindingEventReplayError && error.eventIndex === null) {
        throw new FindingEventReplayError(error.message, eventIndex);
      }
      throw error;
    }
  }

  return { findings, chain_tip: expectedPrevHash };
}

function applyGlobalFindingEvent(
  findings: Map<string, FindingProjection>,
  event: FindingEvent,
  expectedPrevHash: string,
): string {
  assertFindingEvent(event);
  if (event.prev_hash !== expectedPrevHash) {
    throw new FindingEventReplayError(
      `chain break before event ${event.event_id}: expected ${expectedPrevHash}, received ${event.prev_hash}`,
    );
  }
  const computedHash = computeFindingEventHash(event);
  if (computedHash !== event.content_hash) {
    throw new FindingEventReplayError(
      `content hash mismatch for event ${event.event_id}: expected ${computedHash}, received ${event.content_hash}`,
    );
  }

  const current = findings.get(event.finding_id);
  const expectedVersion = (current?.version ?? 0) + 1;
  if (event.version !== expectedVersion) {
    throw new FindingEventReplayError(
      `version gap for ${event.finding_id}: expected ${expectedVersion}, received ${event.version}`,
    );
  }

  findings.set(event.finding_id, applyFindingEvent(current, event));
  return event.content_hash;
}

export function replayFindingProjection(events: readonly FindingEvent[]): FindingProjection | null {
  let projection: FindingProjection | undefined;
  let findingId: string | undefined;
  for (const event of events) {
    assertFindingEvent(event);
    if (findingId && event.finding_id !== findingId) {
      throw new FindingEventReplayError(
        `projection replay mixed finding identities: ${findingId} and ${event.finding_id}`,
      );
    }
    findingId = event.finding_id;
    const computedHash = computeFindingEventHash(event);
    if (computedHash !== event.content_hash) {
      throw new FindingEventReplayError(
        `content hash mismatch for event ${event.event_id}: expected ${computedHash}, received ${event.content_hash}`,
      );
    }
    const expectedVersion = (projection?.version ?? 0) + 1;
    if (event.version !== expectedVersion) {
      throw new FindingEventReplayError(
        `version gap for ${event.finding_id}: expected ${expectedVersion}, received ${event.version}`,
      );
    }
    projection = applyFindingEvent(projection, event);
  }
  return projection ?? null;
}

function assertFindingEvent(event: FindingEvent): void {
  assertExactKeys(
    event,
    [
      'event_id',
      'finding_id',
      'version',
      'event_type',
      'payload',
      'main_sha',
      'occurred_at',
      'prev_hash',
      'content_hash',
    ],
    'FindingEvent',
  );
  assertPattern(
    event.event_id,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    'event_id',
  );
  assertPattern(event.finding_id, /^[A-Z][A-Z0-9]*-[A-Z0-9]+-[0-9]{3}$/, 'finding_id');
  if (!Number.isSafeInteger(event.version) || event.version < 1) {
    throw new FindingEventReplayError(`invalid version for ${event.finding_id}`);
  }
  if (!(FINDING_EVENT_TYPES as readonly string[]).includes(event.event_type)) {
    throw new FindingEventReplayError(`unsupported event type: ${String(event.event_type)}`);
  }
  assertPattern(event.main_sha, /^[0-9a-f]{40}$/, 'main_sha');
  assertIsoDateTime(event.occurred_at, 'occurred_at');
  assertPattern(event.prev_hash, /^[0-9a-f]{64}$/, 'prev_hash');
  assertPattern(event.content_hash, /^[0-9a-f]{64}$/, 'content_hash');

  switch (event.event_type) {
    case 'CREATED':
      assertCreatedPayload(event.payload as FindingCreatedPayload);
      return;
    case 'EVIDENCE_ADDED': {
      const payload = event.payload as FindingEventPayloadMap['EVIDENCE_ADDED'];
      assertExactKeys(payload, ['evidence'], event.event_type);
      assertStringArray(payload.evidence, 'evidence');
      if (payload.evidence.length === 0) {
        throw new FindingEventReplayError('EVIDENCE_ADDED requires at least one citation');
      }
      return;
    }
    case 'OWNER_ASSIGNED': {
      const payload = event.payload as FindingEventPayloadMap['OWNER_ASSIGNED'];
      assertExactKeys(payload, ['owner_agent', 'owner_user'], event.event_type);
      assertNonEmptyString(payload.owner_agent, 'owner_agent');
      assertNullableString(payload.owner_user, 'owner_user');
      return;
    }
    case 'STATE_TRANSITIONED': {
      const payload = event.payload as FindingEventPayloadMap['STATE_TRANSITIONED'];
      assertExactKeys(
        payload,
        ['from_state', 'to_state', 'closing_commit', 'closed_at'],
        event.event_type,
      );
      assertFindingState(payload.from_state, 'from_state');
      assertFindingState(payload.to_state, 'to_state');
      if (payload.closing_commit !== null) {
        assertPattern(payload.closing_commit, /^[0-9a-f]{7,40}$/, 'closing_commit');
      }
      if (payload.closed_at !== null) assertIsoDateTime(payload.closed_at, 'closed_at');
      return;
    }
    case 'SUPERSEDED': {
      const payload = event.payload as FindingEventPayloadMap['SUPERSEDED'];
      assertExactKeys(
        payload,
        ['successor_finding_id', 'adr_evidence', 'closed_at'],
        event.event_type,
      );
      assertPattern(
        payload.successor_finding_id,
        /^[A-Z][A-Z0-9]*-[A-Z0-9]+-[0-9]{3}$/,
        'successor_finding_id',
      );
      assertNonEmptyString(payload.adr_evidence, 'adr_evidence');
      assertIsoDateTime(payload.closed_at, 'closed_at');
      return;
    }
  }
}

function assertCreatedPayload(payload: FindingCreatedPayload): void {
  assertExactKeys(
    payload,
    [
      'severity',
      'state',
      'title',
      'layer',
      'owner_agent',
      'raised_in_cycle',
      'review_file',
      'evidence',
      'rule_violated',
      'notes',
      'narrative',
      'deadline',
      'owner_user',
      'override_of',
      'closing_commits',
      'created_at',
      'closed_at',
    ],
    'CREATED',
  );
  if (!(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const).includes(payload.severity)) {
    throw new FindingEventReplayError(`invalid severity: ${String(payload.severity)}`);
  }
  assertFindingState(payload.state, 'state');
  assertNonEmptyString(payload.title, 'title');
  if (payload.layer !== null && ![1, 2, 3, 4, 5].includes(payload.layer)) {
    throw new FindingEventReplayError(`invalid layer: ${String(payload.layer)}`);
  }
  assertNonEmptyString(payload.owner_agent, 'owner_agent');
  assertNonEmptyString(payload.raised_in_cycle, 'raised_in_cycle');
  assertNullableString(payload.review_file, 'review_file');
  assertStringArray(payload.evidence, 'evidence');
  assertNullableString(payload.rule_violated, 'rule_violated');
  assertNullableString(payload.notes, 'notes');
  assertStringArray(payload.narrative, 'narrative');
  assertNullableString(payload.deadline, 'deadline');
  assertNullableString(payload.owner_user, 'owner_user');
  assertNullableString(payload.override_of, 'override_of');
  assertStringArray(payload.closing_commits, 'closing_commits');
  for (const sha of payload.closing_commits) {
    assertPattern(sha, /^[0-9a-f]{7,40}$/, 'closing_commits[]');
  }
  assertIsoDateTime(payload.created_at, 'created_at');
  if (payload.closed_at !== null) assertIsoDateTime(payload.closed_at, 'closed_at');
}

function assertExactKeys(value: unknown, expected: readonly string[], context: string): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new FindingEventReplayError(`${context} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const canonicalExpected = [...expected].sort();
  if (
    actual.length !== canonicalExpected.length ||
    actual.some((key, index) => key !== canonicalExpected[index])
  ) {
    throw new FindingEventReplayError(
      `${context} payload keys must be exactly [${canonicalExpected.join(', ')}], received [${actual.join(', ')}]`,
    );
  }
}

function assertFindingState(value: string, field: string): void {
  if (
    !(['OPEN', 'IN-PROGRESS', 'RESOLVED', 'STALE', 'BLOCKED'] as const).includes(
      value as FindingState,
    )
  ) {
    throw new FindingEventReplayError(`invalid ${field}: ${String(value)}`);
  }
}

function assertStringArray(value: readonly string[], field: string): void {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new FindingEventReplayError(`${field} must be an array of strings`);
  }
}

function assertNonEmptyString(value: string, field: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new FindingEventReplayError(`${field} must be a non-empty string`);
  }
}

function assertNullableString(value: string | null, field: string): void {
  if (value !== null && typeof value !== 'string') {
    throw new FindingEventReplayError(`${field} must be a string or null`);
  }
}

function assertIsoDateTime(value: string, field: string): void {
  if (typeof value !== 'string' || Number.isNaN(new Date(value).getTime())) {
    throw new FindingEventReplayError(`${field} must be an ISO date-time`);
  }
}

function assertPattern(value: string, pattern: RegExp, field: string): void {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new FindingEventReplayError(`invalid ${field}: ${String(value)}`);
  }
}

function applyFindingEvent(
  current: FindingProjection | undefined,
  event: FindingEvent,
): FindingProjection {
  if (event.event_type === 'CREATED') {
    if (current) {
      throw new FindingEventReplayError(`duplicate CREATED event for ${event.finding_id}`);
    }
    const payload = event.payload as FindingCreatedPayload;
    return {
      ...payload,
      evidence: [...payload.evidence],
      narrative: [...payload.narrative],
      closing_commits: [...payload.closing_commits],
      finding_id: event.finding_id,
      version: event.version,
      superseded_by: null,
      last_event_id: event.event_id,
      last_main_sha: event.main_sha,
      last_occurred_at: event.occurred_at,
    };
  }
  if (!current) {
    throw new FindingEventReplayError(
      `${event.event_type} cannot precede CREATED for ${event.finding_id}`,
    );
  }

  const common = {
    ...current,
    version: event.version,
    last_event_id: event.event_id,
    last_main_sha: event.main_sha,
    last_occurred_at: event.occurred_at,
  };
  switch (event.event_type) {
    case 'EVIDENCE_ADDED': {
      const payload = event.payload as FindingEventPayloadMap['EVIDENCE_ADDED'];
      return { ...common, evidence: [...new Set([...current.evidence, ...payload.evidence])] };
    }
    case 'OWNER_ASSIGNED': {
      const payload = event.payload as FindingEventPayloadMap['OWNER_ASSIGNED'];
      return { ...common, owner_agent: payload.owner_agent, owner_user: payload.owner_user };
    }
    case 'STATE_TRANSITIONED': {
      const payload = event.payload as FindingEventPayloadMap['STATE_TRANSITIONED'];
      if (payload.from_state !== current.state) {
        throw new FindingEventReplayError(
          `state mismatch for ${event.finding_id}: projection=${current.state}, event.from_state=${payload.from_state}`,
        );
      }
      if (current.state === 'RESOLVED') {
        throw new FindingEventReplayError(`RESOLVED finding ${event.finding_id} is terminal`);
      }
      if (payload.to_state === current.state) {
        throw new FindingEventReplayError(
          `state transition for ${event.finding_id} must change state`,
        );
      }
      if (payload.to_state === 'RESOLVED' && (!payload.closing_commit || !payload.closed_at)) {
        throw new FindingEventReplayError(
          `RESOLVED transition for ${event.finding_id} requires closing_commit and closed_at`,
        );
      }
      if (payload.to_state !== 'RESOLVED' && (payload.closing_commit || payload.closed_at)) {
        throw new FindingEventReplayError(
          `non-RESOLVED transition for ${event.finding_id} cannot carry closure evidence`,
        );
      }
      const closingCommits = payload.closing_commit
        ? [...new Set([...current.closing_commits, payload.closing_commit])]
        : current.closing_commits;
      return {
        ...common,
        state: payload.to_state,
        closing_commits: closingCommits,
        closed_at: payload.closed_at,
      };
    }
    case 'SUPERSEDED': {
      const payload = event.payload as FindingEventPayloadMap['SUPERSEDED'];
      if (payload.successor_finding_id === event.finding_id) {
        throw new FindingEventReplayError(`finding ${event.finding_id} cannot supersede itself`);
      }
      if (current.state === 'RESOLVED') {
        throw new FindingEventReplayError(`RESOLVED finding ${event.finding_id} is terminal`);
      }
      return {
        ...common,
        state: 'RESOLVED',
        superseded_by: payload.successor_finding_id,
        closed_at: payload.closed_at,
        notes: current.notes
          ? `${current.notes}\nSuperseded: ${payload.adr_evidence}`
          : `Superseded: ${payload.adr_evidence}`,
      };
    }
    default:
      throw new FindingEventReplayError(`unsupported event type: ${String(event.event_type)}`);
  }
}
