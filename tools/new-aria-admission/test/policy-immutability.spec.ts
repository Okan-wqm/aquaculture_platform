import { loadEventPolicy } from '../src/kernel/policy';

import { eventPolicyBytes } from './progress-fixture';

describe('event policy capability', () => {
  it('does not expose mutable transition authority across verifier calls', () => {
    const first = loadEventPolicy(eventPolicyBytes);
    const transitions = first.transitions.PLANNED;
    if (transitions === undefined) throw new Error('PLANNED transition policy is missing');

    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.states)).toBe(true);
    expect(Object.isFrozen(first.transitions)).toBe(true);
    expect(Object.isFrozen(transitions)).toBe(true);
    expect(Reflect.set(first.transitions, 'PLANNED', ['DONE'])).toBe(false);
    expect(Reflect.set(transitions, '0', 'DONE')).toBe(false);

    expect(loadEventPolicy(eventPolicyBytes).transitions.PLANNED).toEqual([
      'READY',
      'BLOCKED',
      'SUPERSEDED',
    ]);
  });
});
