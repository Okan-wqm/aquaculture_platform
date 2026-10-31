import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { AI_CHAT_DRAFT_FRAME_LIMIT } from '@aquaculture/shared-contracts';

/**
 * MSG-MEDIUM-089: a streamed request.ai.chat reply is draft frames, the
 * result, and the NestJS closing packet, each one NATS message to the
 * requester's reply inbox. The broker allows a responder a bounded number of
 * them per request (`allow_responses`, one generator constant for every
 * identity); a reply that needs more is cut off before its result, and the
 * caller waits out its timeout for a reply that was written.
 */
const REPO_ROOT = resolve(__dirname, '../..');

function allowedResponses(source: string): number {
  const match = /^ALLOW_RESPONSES = '\{ max: (\d+), expires: "\d+[smh]" \}'$/m.exec(source);
  if (!match?.[1]) {
    throw new Error('ALLOW_RESPONSES not found in scripts/nats/generate-nats-conf.py');
  }
  return Number(match[1]);
}

describe('request.ai.chat reply frames fit the broker reply allowance (MSG-MEDIUM-089)', () => {
  const generator = readFileSync(resolve(REPO_ROOT, 'scripts/nats/generate-nats-conf.py'), 'utf-8');
  const natsConf = readFileSync(
    resolve(REPO_ROOT, 'infrastructure/docker/nats/nats.conf'),
    'utf-8',
  );

  it('allows every draft frame, the result and the closing packet', () => {
    expect(AI_CHAT_DRAFT_FRAME_LIMIT + 2).toBeLessThanOrEqual(allowedResponses(generator));
  });

  it('is what the generated broker config grants every user', () => {
    const granted = [...natsConf.matchAll(/allow_responses: \{ max: (\d+),/g)].map((m) =>
      Number(m[1]),
    );
    expect(granted.length).toBeGreaterThan(0);
    expect(new Set(granted)).toEqual(new Set([allowedResponses(generator)]));
  });
});
