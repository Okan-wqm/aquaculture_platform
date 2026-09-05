// Guards the one rule every legal control hangs off: a control is shown only
// when the server says this principal may use it.
import { describe, expect, it } from 'vitest';
import type { WhoAmIResponse } from '../../../shared/api-contract.ts';
import { canPerform } from './permissions.ts';

const ME: WhoAmIResponse = {
  principal: { id: 'console-token-holder', displayName: 'Console token holder', role: 'operator', cases: '*' },
  permissions: { kernel_control: false, case_intake: true, corpus_inventory: true, statement_verification: false },
};

describe('canPerform', () => {
  it('answers from the permissions map, class by class', () => {
    expect(canPerform(ME, 'case_intake')).toBe(true);
    expect(canPerform(ME, 'statement_verification')).toBe(false);
    expect(canPerform(ME, 'kernel_control')).toBe(false);
  });

  it('treats an absent class and an unloaded answer as no', () => {
    expect(canPerform(ME, 'redaction_and_production')).toBe(false);
    expect(canPerform(null, 'case_intake')).toBe(false);
  });
});
