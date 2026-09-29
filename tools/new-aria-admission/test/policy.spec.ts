import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { canonicalJsonBytes } from '../src/kernel/canonical-json';
import { loadEventPolicy } from '../src/kernel/policy';

const path = join(__dirname, '../policy/event-policy.json');

describe('event policy source of truth', () => {
  it('loads the production policy with exact states and transitions', () => {
    const policy = loadEventPolicy(readFileSync(path));
    expect(policy.states).toEqual([
      'PLANNED',
      'READY',
      'IN_PROGRESS',
      'VERIFYING',
      'DONE',
      'BLOCKED',
      'SUPERSEDED',
    ]);
    expect(policy.transitions.VERIFYING).toEqual(['DONE', 'BLOCKED', 'SUPERSEDED']);
    expect(loadEventPolicy(canonicalJsonBytes(policy))).toEqual(policy);
  });

  it('rejects a well-formed but drifted literal graph', () => {
    const policy = loadEventPolicy(readFileSync(path));
    const drifted = {
      ...policy,
      states: [...policy.states, 'CLEAN'],
      transitions: { ...policy.transitions, CLEAN: [] },
    };
    expect(() => loadEventPolicy(canonicalJsonBytes(drifted))).toThrow(/literal/);
  });
});
