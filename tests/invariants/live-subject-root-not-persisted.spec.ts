import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { AI_REPLY_DRAFT_SUBSCRIPTION } from '@platform/event-contracts';

/**
 * MSG-MEDIUM-089: the `live.` subject root carries signals a UI shows while
 * they happen (an AI reply's draft). They are worth nothing once the moment
 * passes, so no JetStream stream may capture them: a captured draft would be
 * stored and replayed to consumers as if it were an event.
 */
const EVENT_BUS = resolve(__dirname, '../../platform/libs/event-bus/src/nats/nats-event-bus.ts');

describe('the live subject root is in no JetStream stream (MSG-MEDIUM-089)', () => {
  const source = readFileSync(EVENT_BUS, 'utf-8');
  const streamSubjects = [...source.matchAll(/subjects: \[([^\]]*)\]/g)].flatMap((m) =>
    [...(m[1] ?? '').matchAll(/'([^']+)'/g)].map((s) => s[1] ?? ''),
  );

  it('finds the streams the event bus declares', () => {
    expect(streamSubjects).toEqual(expect.arrayContaining(['events.>', 'telemetry.>']));
  });

  it('declares no stream subject that captures live.*', () => {
    const captures = (filter: string): boolean =>
      filter === '>' || filter.startsWith('live.') || filter.startsWith('*.');
    expect(streamSubjects.filter(captures)).toEqual([]);
  });

  it('publishes AI reply drafts under the live root', () => {
    expect(AI_REPLY_DRAFT_SUBSCRIPTION.startsWith('live.')).toBe(true);
  });
});
