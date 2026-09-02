#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { eventHash, parseStrictJson, sha256File } from './lib/canonical.mjs';
import { verifyEvents } from './lib/verify-events.mjs';
import { mutateJson, withPlanCopy } from './test-support.mjs';

const failures = [];

function rehash(events, start) {
  for (let index = start; index < events.length; index += 1) {
    events[index].previous_hash = index === 0 ? '0'.repeat(64) : events[index - 1].event_hash;
    events[index].event_hash = eventHash(events[index]);
  }
}

function eventCase(name, mutate, code = 'EVENT_SEMANTICS') {
  withPlanCopy('new-aria-d0-event-', (copy) => {
    const path = join(copy, 'progress/events.jsonl');
    const events = readFileSync(path, 'utf8').trimEnd().split('\n').map(JSON.parse);
    const start = mutate(events, copy);
    rehash(events, start);
    writeFileSync(path, `${events.map(JSON.stringify).join('\n')}\n`);
    const errors = verifyEvents(copy);
    if (!errors.some((error) => error.code === code)) {
      failures.push(`${name}: expected ${code}, received ${JSON.stringify(errors)}`);
    }
  });
}

eventCase('illegal continuity', (events) => {
  events[5].from_state = 'READY';
  return 5;
});

eventCase('unknown field', (events) => {
  events[5].unknown_field = 'deny';
  return 5;
});

eventCase('missing field', (events) => {
  delete events[5].actor_id;
  return 5;
});

eventCase('illegal admission', (events) => {
  events[5].admission = true;
  return 5;
});

eventCase(
  'altered evidence relation',
  (events, copy) => {
    const evidence = 'progress/evidence/D0-review-c6065d6d-changes-required.json';
    events[5].evidence_uri = evidence;
    events[5].evidence_digest = sha256File(join(copy, evidence));
    return 5;
  },
  'D0_STATE',
);

eventCase('extra row', (events) => {
  events.push({ ...events.at(-1), event_id: 'd0-0007' });
  return 6;
});

withPlanCopy('new-aria-d0-event-policy-', (copy) => {
  mutateJson(copy, 'verification/event-policy.json', (policy) => {
    policy.legal_transitions.push('VERIFYING->READY');
  });
  const errors = verifyEvents(copy);
  if (!errors.some((error) => error.code === 'EVENT_SEMANTICS')) {
    failures.push(`coordinated policy expansion accepted: ${JSON.stringify(errors)}`);
  }
});

for (const [source, pattern] of [
  ['{"a":1.0}', /floating-point/u],
  ['{"a":1e0}', /floating-point/u],
  ['{"a":9007199254740992}', /safe integer/u],
  ['{"a":-0}', /negative zero/u],
  ['{"a":1,"a":2}', /duplicate key/u],
  ['{"a":"\\ud800"}', /Unicode scalar/u],
]) {
  assert.throws(() => parseStrictJson(source), pattern);
}

assert.deepEqual(failures, [], `event controls accepted:\n${failures.join('\n')}`);
process.stdout.write('PASS event-controls\n');
