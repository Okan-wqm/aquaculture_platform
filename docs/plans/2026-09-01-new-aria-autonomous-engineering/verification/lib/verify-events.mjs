import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { eventHash, parseStrictJson, sha256, sha256File } from './canonical.mjs';

const firstFiveDigest = '1dfe5804be9cfabd811efe8f85ff86c8e4f9931799365f3073f5e58794082cb6';
const commonFields = [
  'schema_version',
  'program_id',
  'event_id',
  'sprint_id',
  'from_state',
  'to_state',
  'occurred_at',
  'actor_id',
  'baseline_sha',
  'target_sha',
  'target_binding',
  'authority_path',
  'claim',
  'evidence_uri',
];
const expectedPolicy = {
  schema_version: '1.0.0',
  contract_id: 'new-aria-d0-event-chain-v1',
  states: ['PLANNED', 'READY', 'IN_PROGRESS', 'VERIFYING'],
  legal_transitions: [
    'null->PLANNED',
    'PLANNED->READY',
    'READY->IN_PROGRESS',
    'IN_PROGRESS->VERIFYING',
    'VERIFYING->VERIFYING',
  ],
  classes: {
    lifecycle: [...commonFields, 'previous_hash', 'event_hash'],
    materialization: [
      ...commonFields,
      'previous_hash',
      'evidence_digest_algorithm',
      'evidence_digest',
      'event_hash',
    ],
    review: [
      ...commonFields,
      'evidence_digest_algorithm',
      'evidence_digest',
      'review_verdict',
      'admission',
      'previous_hash',
      'event_hash',
    ],
  },
  row_classes: ['lifecycle', 'lifecycle', 'lifecycle', 'materialization', 'review', 'review'],
  tail: {
    event_id: 'd0-0006',
    to_state: 'VERIFYING',
    review_verdict: 'CHANGES_REQUIRED',
    admission: false,
    evidence_uri: 'progress/evidence/D0-review-c139f40f-changes-required.json',
  },
};

function add(errors, code, message) {
  errors.push({ code, message });
}

function equal(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function verifyShape(errors, event, index, policy) {
  const className = policy.row_classes[index];
  const fields = policy.classes[className] ?? [];
  if (!equal(Object.keys(event), fields)) {
    add(errors, 'EVENT_SEMANTICS', `${event.event_id}: ${className} schema is open or incomplete`);
  }
  const identity = [event.schema_version, event.program_id, event.sprint_id];
  if (
    JSON.stringify(identity) !== JSON.stringify(['1.0.0', 'new-aria-autonomous-engineering', 'D0'])
  ) {
    add(errors, 'EVENT_SEMANTICS', `${event.event_id}: event identity drift`);
  }
  const reviewSemantics = [event.review_verdict, event.admission, event.from_state, event.to_state];
  if (
    className === 'review' &&
    !equal(reviewSemantics, ['CHANGES_REQUIRED', false, 'VERIFYING', 'VERIFYING'])
  ) {
    add(errors, 'EVENT_SEMANTICS', `${event.event_id}: illegal review admission semantics`);
  }
}

function verifyRelation(errors, planRoot, event) {
  if (event.evidence_uri === null) {
    if ('evidence_digest' in event) add(errors, 'EVENT_SEMANTICS', 'null evidence has digest');
  } else {
    const path = join(planRoot, event.evidence_uri);
    if (
      event.evidence_digest_algorithm !== 'sha256' ||
      sha256File(path) !== event.evidence_digest
    ) {
      add(errors, 'EVENT_CHAIN', `${event.event_id}: evidence relation mismatch`);
      return;
    }
    const evidence = parseStrictJson(readFileSync(path, 'utf8'));
    if (
      event.review_verdict &&
      (evidence.reviewed_target.head_sha !== event.target_sha ||
        evidence.reviewed_target.verdict !== event.review_verdict ||
        evidence.admission.accepted !== event.admission)
    ) {
      add(errors, 'EVENT_SEMANTICS', `${event.event_id}: review evidence semantics mismatch`);
    }
  }
}

export function verifyEvents(planRoot) {
  const errors = [];
  const raw = readFileSync(join(planRoot, 'progress/events.jsonl'), 'utf8');
  const lines = raw.trimEnd().split('\n');
  const firstFive = Buffer.from(`${lines.slice(0, 5).join('\n')}\n`, 'utf8');
  if (sha256(firstFive) !== firstFiveDigest) add(errors, 'EVENT_CHAIN', 'first five bytes changed');
  const policy = parseStrictJson(
    readFileSync(join(planRoot, 'verification/event-policy.json'), 'utf8'),
  );
  if (!equal(policy, expectedPolicy)) add(errors, 'EVENT_SEMANTICS', 'event policy identity drift');
  if (lines.length !== 6) add(errors, 'EVENT_SEMANTICS', 'event row count must be six');
  let previousHash = '0'.repeat(64);
  let previousState = null;
  let latest;
  for (let index = 0; index < lines.length; index += 1) {
    try {
      const event = parseStrictJson(lines[index]);
      verifyShape(errors, event, index, policy);
      verifyContinuity(errors, event, {
        index,
        previousHash,
        previousState,
        policy,
      });
      verifyRelation(errors, planRoot, event);
      previousHash = event.event_hash;
      previousState = event.to_state;
      latest = event;
    } catch (error) {
      add(errors, 'EVENT_CHAIN', `row ${index + 1}: ${error.message}`);
    }
  }
  for (const [key, value] of Object.entries(policy.tail)) {
    if (typeof latest !== 'object' || latest === null || latest[key] !== value) {
      add(errors, 'D0_STATE', `event tail ${key} drift`);
    }
  }
  return errors;
}

function verifyContinuity(errors, event, context) {
  const { index, previousHash, previousState, policy } = context;
  const transition = `${event.from_state ?? 'null'}->${event.to_state}`;
  if (!policy.legal_transitions.includes(transition) || event.from_state !== previousState) {
    add(errors, 'EVENT_SEMANTICS', `${event.event_id}: illegal transition or continuity`);
  }
  const identity = [event.event_id, event.previous_hash, eventHash(event)];
  const expected = [`d0-${String(index + 1).padStart(4, '0')}`, previousHash, event.event_hash];
  if (JSON.stringify(identity) !== JSON.stringify(expected)) {
    add(errors, 'EVENT_CHAIN', `${event.event_id}: ID/hash chain mismatch`);
  }
}
